import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { checkRelay, relay, RELAYABLE, RelayRefused, type RelayContext } from "../src/relay.ts";
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
    const out = Transaction.from(await relay(raw([gapIx("claim")]), ctx, payer));
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
