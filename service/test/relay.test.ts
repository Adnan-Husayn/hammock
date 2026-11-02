import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { BorshAccountsCoder, BN } from "@coral-xyz/anchor";
import { checkRelay, relay, RELAYABLE, RelayRefused, sandboxMarketCheck, type RelayContext } from "../src/relay.ts";
import { serviceServer, clientIp, RateLimit, RELAY_MIN_LAMPORTS, RELAY_PER_MINUTE_IP, RELAY_PER_MINUTE_USER, FAUCET_PER_MINUTE } from "../src/server.ts";
import { signQuote } from "../src/quote.ts";

const programId = Keypair.generate().publicKey;
const payer = Keypair.generate();
const user = Keypair.generate();
const sandboxMarket = Keypair.generate().publicKey;
const realMarket = Keypair.generate().publicKey;
const quoteKey = Keypair.generate();
const BLOCKHASH = "11111111111111111111111111111111";

const ctx: RelayContext = {
  programId,
  feePayer: payer.publicKey,
  isSandboxMarket: async (m) => m.equals(sandboxMarket),
};

function gapIx(kind: keyof typeof RELAYABLE, o: { market?: PublicKey; owner?: PublicKey; program?: PublicKey; data?: Buffer } = {}) {
  return new TransactionInstruction({
    programId: o.program ?? programId,
    keys: [
      { pubkey: o.owner ?? user.publicKey, isSigner: true, isWritable: true },
      { pubkey: o.market ?? sandboxMarket, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    ],
    data: o.data ?? RELAYABLE[kind],
  });
}
const edIx = () =>
  signQuote({ market: sandboxMarket, buyer: user.publicKey, contracts: 1, premiumPerContract: 7_000n, expiry: 1n, nonce: 1n }, quoteKey).instruction;

function raw(ixs: TransactionInstruction[], feePayer = payer.publicKey) {
  const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
const refused = async (ixs: TransactionInstruction[], why: RegExp, feePayer?: PublicKey) => {
  const p = checkRelay(raw(ixs, feePayer), ctx);
  await expect(p).rejects.toBeInstanceOf(RelayRefused);
  await expect(p).rejects.toThrow(why);
};

describe("relay accepts", () => {
  it("Ed25519 quote + buy, with a compute limit at the cap", async () => {
    const r = await checkRelay(raw([edIx(), gapIx("buy"), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]), ctx);
    expect(r.kind).toBe("buy");
    expect(r.user.equals(user.publicKey)).toBe(true);
  });
  it("claim and refund alone", async () => {
    expect((await checkRelay(raw([gapIx("claim")]), ctx)).kind).toBe("claim");
    expect((await checkRelay(raw([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), gapIx("refund")]), ctx)).kind).toBe("refund");
  });
  it("partially signs as fee payer and leaves the user signature for the wallet", async () => {
    const out = Transaction.from((await relay(raw([gapIx("claim")]), ctx, payer)).transaction);
    const sigs = out.signatures;
    expect(sigs[0].publicKey.equals(payer.publicKey) && sigs[0].signature !== null).toBe(true);
    expect(sigs[1].publicKey.equals(user.publicKey) && sigs[1].signature === null).toBe(true);
    out.partialSign(user);
    expect(out.verifySignatures()).toBe(true);
  });
});

describe("relay refuses", () => {
  it("a program other than gap_cover", async () => {
    await refused([gapIx("claim", { program: Keypair.generate().publicKey })], /not allowed/);
    await refused([gapIx("claim"), SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 1 })], /not allowed/);
  });
  it("a market that is not sandbox", async () => {
    await refused([gapIx("claim", { market: realMarket })], /sandbox markets only/);
  });
  it("an instruction other than buy, claim or refund", async () => {
    await refused([gapIx("claim", { data: Buffer.from([40, 23, 234, 175, 14, 61, 154, 177]) })], /only buy, claim or refund/); // sweep
    await refused([gapIx("claim", { data: Buffer.concat([RELAYABLE.claim, Buffer.from([0])]) })], /only buy, claim or refund/);
    await refused([gapIx("claim"), gapIx("refund")], /only one gap_cover/);
    await refused([ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })], /no gap_cover/);
  });
  it("more than 3 instructions", async () => {
    const cu = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 });
    await refused([edIx(), gapIx("buy"), cu(), cu()], /at most 3/);
  });
  it("more than 400_000 compute units, a priority fee or a heap request", async () => {
    await refused([gapIx("claim"), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_001 })], /above 400000/);
    await refused([gapIx("claim"), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })], /only SetComputeUnitLimit/);
    await refused([gapIx("claim"), ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })], /only SetComputeUnitLimit/);
  });
  it("Ed25519 anywhere but as buy's index-0 quote", async () => {
    await refused([gapIx("buy")], /index 0/);
    await refused([edIx(), gapIx("claim")], /index 0/);
    await refused([ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }), edIx(), gapIx("buy")], /Ed25519 only at index 0/);
    const bad = edIx();
    bad.data = Buffer.from(bad.data);
    bad.data.writeUInt16LE(0, 14); // message in instruction 0 instead of inline
    await refused([bad, gapIx("buy")], /not an inline quote/);
  });
  it("a fee payer other than the relay key, or the relay key inside an instruction", async () => {
    await refused([gapIx("claim")], /fee payer/, user.publicKey);
    await refused([gapIx("claim", { owner: payer.publicKey })], /relay key may only pay fees/);
  });
  it("extra signers", async () => {
    const ix = gapIx("claim");
    ix.keys[2].isSigner = true;
    await refused([ix], /signers must be/);
  });
  it("garbage and versioned transactions", async () => {
    await expect(checkRelay(Buffer.from([1, 2, 3]), ctx)).rejects.toBeInstanceOf(RelayRefused);
    const legacy = raw([gapIx("claim")]);
    const v0 = Buffer.from(legacy);
    v0[1 + 64 * 2] |= 0x80;
    await expect(checkRelay(v0, ctx)).rejects.toThrow(/legacy/);
  });
});

/* ---------- chain-backed sandbox check ---------- */

const idl = JSON.parse(readFileSync(new URL("../../idl/gap_cover.json", import.meta.url), "utf8"));
async function sandboxMarketBytes() {
  const k = PublicKey.default;
  const bn = (n: number) => new BN(n);
  return new BorshAccountsCoder(idl).encode("Market", {
    dealer: k, bump: 0, vault_bump: 0, feed_id: 1314, exponent: -5, stock_mint: k, usdc_mint: k, token_program: k, escrow: k,
    collateral_reserve: k, bounty_reserve: k, friday_target_ts_us: bn(0), monday_target_ts_us: bn(0), buying_close_ts: bn(0),
    band_lower_bps: 100, band_upper_bps: 500, friday_conf_cap_bps: 10, monday_conf_cap_bps: 20, min_publishers: 10,
    eligibility_half_window_us: bn(0), submission_window_us: bn(0), max_contracts: 200, bounty_per_leg: bn(0), claim_deadline_s: bn(0),
    dealer_quote_key: k, quote_max_lifetime_s: bn(90), sandbox: true, demo_authority: k, sandbox_mode: { Gap: {} },
    creation_multiplier_bits: bn(0), created_at: bn(0), state: { FridayFinal: {} }, friday: null, monday: null, contracts_sold: 0,
    total_premiums: bn(0), open_positions: 0, swept: false, payout_per_contract: bn(0), buying_closed: false, settled_at: bn(0),
  });
}

describe("relay sandbox check reads chain state", () => {
  it("accepts a gap_cover-owned sandbox market and refuses a look-alike owned by another program", async () => {
    const data = await sandboxMarketBytes();
    const fake = Keypair.generate().publicKey;
    const conn = {
      getAccountInfo: async (k: PublicKey) =>
        ({ data, owner: k.equals(sandboxMarket) ? programId : fake, lamports: 1, executable: false }) as any,
    };
    const chainCtx: RelayContext = { programId, feePayer: payer.publicKey, isSandboxMarket: sandboxMarketCheck(conn, programId) };
    expect((await checkRelay(raw([gapIx("claim")]), chainCtx)).kind).toBe("claim");
    const lookAlike = Keypair.generate().publicKey;
    await expect(checkRelay(raw([gapIx("claim", { market: lookAlike })]), chainCtx)).rejects.toThrow(/sandbox markets only/);
  });
});

/* ---------- HTTP limits ---------- */

async function withServer(o: { balance?: number; user?: () => PublicKey }, fn: (u: string) => Promise<void>) {
  let t = 0;
  const s = serviceServer({
    quoter: {} as any, sandbox: {} as any, relayPayer: payer.publicKey,
    relay: async () => ({ transaction: Buffer.from("ok"), user: o.user ? o.user() : user.publicKey }),
    faucet: async () => "sig",
    relayBalance: async () => o.balance ?? RELAY_MIN_LAMPORTS,
    nowMs: () => t,
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  try {
    await fn(`http://127.0.0.1:${(s.address() as any).port}`);
  } finally {
    s.close();
  }
}
const post = (u: string, path: string, b: unknown) => fetch(u + path, { method: "POST", body: JSON.stringify(b) }).then((r) => r.status);

describe("HTTP limits", () => {
  it("relay refuses below the SOL balance floor", async () => {
    await withServer({ balance: RELAY_MIN_LAMPORTS - 1 }, async (u) => {
      expect(await post(u, "/relay", { transaction: "AA==" })).toBe(503);
    });
  });
  it("relay limits each wallet per minute", async () => {
    await withServer({}, async (u) => {
      for (let i = 0; i < RELAY_PER_MINUTE_USER; i++) expect(await post(u, "/relay", { transaction: "AA==" })).toBe(200);
      expect(await post(u, "/relay", { transaction: "AA==" })).toBe(429);
    });
  });
  it("relay limits each IP per minute across wallets", async () => {
    await withServer({ user: () => Keypair.generate().publicKey }, async (u) => {
      for (let i = 0; i < RELAY_PER_MINUTE_IP; i++) expect(await post(u, "/relay", { transaction: "AA==" })).toBe(200);
      expect(await post(u, "/relay", { transaction: "AA==" })).toBe(429);
    });
  });
  it("faucet has a global per-minute cap", async () => {
    await withServer({}, async (u) => {
      for (let i = 0; i < FAUCET_PER_MINUTE; i++) expect(await post(u, "/faucet", { wallet: Keypair.generate().publicKey.toBase58() })).toBe(200);
      expect(await post(u, "/faucet", { wallet: Keypair.generate().publicKey.toBase58() })).toBe(429);
    });
  });
});

describe("RateLimit and client IP", () => {
  it("evicts keys idle for a minute", () => {
    const r = new RateLimit(1);
    expect(r.take("a", 0)).toBe(true);
    expect(r.take("a", 1)).toBe(false);
    r.take("b", 70_000);
    expect((r as any).hits.has("a")).toBe(false);
    expect(r.take("a", 70_001)).toBe(true);
  });
  it("uses X-Forwarded-For only when TRUST_PROXY is on", () => {
    const req = { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } } as any;
    expect(clientIp(req, false)).toBe("10.0.0.1");
    expect(clientIp(req, true)).toBe("1.2.3.4");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "5.5.5.5" } } as any, true)).toBe("5.5.5.5");
  });
});
