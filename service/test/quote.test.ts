import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, BorshInstructionCoder, BN } from "@coral-xyz/anchor";
import { Freeze } from "../src/pricing.ts";
import {
  Quoter, decodeLastNonce, decodeMarket, encodeQuote, signQuote, type MarketInfo, type Quote,
} from "../src/quote.ts";
import { Sandbox, devnetSandboxChain, encodeSandboxParams, type SandboxChain } from "../src/sandbox.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const idl = JSON.parse(readFileSync(join(ROOT, "idl", "gap_cover.json"), "utf8"));
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));

function verifyEd25519(pub: PublicKey, msg: Buffer, sig: Buffer) {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.toBuffer()]);
  return verify(null, msg, createPublicKey({ key: der, format: "der", type: "spki" }), sig);
}

describe("encodeQuote", () => {
  it("matches the shared vector decoded by Rust decode_quote (programs/gap_cover/tests/data/quote.hex)", () => {
    const hex = readFileSync(join(ROOT, "programs", "gap_cover", "tests", "data", "quote.hex"), "utf8").trim();
    const q: Quote = { market: pk(1), buyer: pk(2), contracts: 7, premiumPerContract: 120_000n, expiry: -5n, nonce: 9n };
    const b = encodeQuote(q);
    expect(b.length).toBe(96);
    expect(b.toString("hex")).toBe(hex);
  });

  it("signQuote builds the inline Ed25519 layout check_inline_ed25519 accepts", () => {
    const key = Keypair.generate();
    const q: Quote = { market: pk(3), buyer: pk(4), contracts: 1, premiumPerContract: 7_000n, expiry: 100n, nonce: 1n };
    const { message, signature, instruction } = signQuote(q, key);
    const d = Buffer.from(instruction.data);
    expect(d[0]).toBe(1);
    expect([d.readUInt16LE(2), d.readUInt16LE(6), d.readUInt16LE(10), d.readUInt16LE(12)]).toEqual([48, 16, 112, 96]);
    expect([d.readUInt16LE(4), d.readUInt16LE(8), d.readUInt16LE(14)]).toEqual([0xffff, 0xffff, 0xffff]);
    expect(d.subarray(16, 48).equals(key.publicKey.toBuffer())).toBe(true);
    expect(d.subarray(112).equals(message)).toBe(true);
    expect(verifyEd25519(key.publicKey, message, signature)).toBe(true);
  });
});

/* ---------- account decoding cross-checked against the Anchor coder ---------- */

// The Anchor 0.30 coder takes the IDL's snake_case field names and PascalCase enum variants.
const snake = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v && v.submitter ? snake(v) : v]));

function marketFields(o: Partial<Record<string, any>> = {}) {
  return snake({
    dealer: pk(9), bump: 1, vaultBump: 2, feedId: 1314, exponent: -5, nvdaxMint: pk(10), usdcMint: pk(11), tokenProgram: pk(12),
    escrow: pk(13), collateralReserve: pk(14), bountyReserve: pk(15), fridayTargetTsUs: new BN(1_000_000_000_000_000), mondayTargetTsUs: new BN(1_000_000_600_000_000),
    buyingCloseTs: new BN(1_000_000_600), bandLowerBps: 100, bandUpperBps: 500, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10,
    eligibilityHalfWindowUs: new BN(5_000_000), submissionWindowUs: new BN(5_000_000), maxContracts: 200, bountyPerLeg: new BN(100_000),
    claimDeadlineS: new BN(2_592_000), dealerQuoteKey: pk(16), quoteMaxLifetimeS: new BN(90), sandbox: true, demoAuthority: pk(17),
    sandboxMode: { Gap: {} }, creationMultiplierBits: new BN(0), createdAt: new BN(1), state: { FridayFinal: {} },
    friday: { price: new BN(20_000_000), feedTsUs: new BN(1_000_000_000_000_000), submitter: pk(17) }, monday: null,
    contractsSold: 12, totalPremiums: new BN(345), openPositions: 2, swept: false, payoutPerContract: new BN(0), buyingClosed: false, settledAt: new BN(0),
    ...o,
  });
}

describe("decodeMarket / decodeLastNonce", () => {
  const coder = new BorshAccountsCoder(idl);
  it("reads the fields the quoter needs", async () => {
    const data = await coder.encode("Market", marketFields());
    const m = decodeMarket(data);
    expect(m.state).toBe("FridayFinal");
    expect(m.sandbox).toBe(true);
    expect(m.sandboxMode).toBe("gap");
    expect(m.dealerQuoteKey.equals(pk(16))).toBe(true);
    expect(m.nvdaxMint.equals(pk(10))).toBe(true);
    expect(m.friday?.price).toBe(20_000_000n);
    expect(m.monday).toBeNull();
    expect([m.contractsSold, m.maxContracts, m.openPositions, m.buyingClosed]).toEqual([12, 200, 2, false]);
    expect(m.buyingCloseTs).toBe(1_000_000_600n);
    expect(m.quoteMaxLifetimeS).toBe(90n);
  });
  it("reads a market with both candidates and buying closed", async () => {
    const data = await coder.encode("Market", marketFields({
      sandboxMode: { MultiplierVoid: {} }, state: { MondayFinal: {} }, buyingClosed: true,
      monday: { price: new BN(19_000_000), feedTsUs: new BN(5), submitter: pk(17) },
    }));
    const m = decodeMarket(data);
    expect([m.state, m.sandboxMode, m.buyingClosed, m.monday?.price]).toEqual(["MondayFinal", "multiplierVoid", true, 19_000_000n]);
  });
  it("Position.last_nonce, 0 without a position", async () => {
    const data = await coder.encode("Position", { contracts: 3, premium_paid: new BN(10), last_nonce: new BN(4), closed: false });
    expect(decodeLastNonce(data)).toBe(4n);
    expect(decodeLastNonce(null)).toBe(0n);
  });
  it("sandbox create_market params encode as the IDL expects", () => {
    const ic = new BorshInstructionCoder(idl);
    const disc = Buffer.from([103, 226, 97, 235, 200, 188, 251, 254]);
    const d = ic.decode(Buffer.concat([disc, encodeSandboxParams(1000n, "multiplierVoid", pk(5), pk(6))]))!;
    const p = (d.data as any).params;
    expect(p.friday_target_ts.toString()).toBe("1000");
    expect(p.monday_target_ts.toString()).toBe("1601");
    expect(p.buying_close_ts.toString()).toBe("1600");
    expect([p.band_lower_bps, p.band_upper_bps, p.friday_conf_cap_bps, p.monday_conf_cap_bps, p.min_publishers]).toEqual([100, 500, 10, 20, 10]);
    expect([p.max_contracts, p.bounty_per_leg.toString(), p.sandbox]).toEqual([200, "100000", true]);
    expect(p.dealer_quote_key.equals(pk(5)) && p.demo_authority.equals(pk(6))).toBe(true);
    expect(p.sandbox_mode).toEqual({ MultiplierVoid: {} });
  });
});

/* ---------- Quoter ---------- */

const NOW_S = 1_000_000_100;
function market(o: Partial<MarketInfo> = {}): MarketInfo {
  return {
    dealer: pk(9), nvdaxMint: pk(10), usdcMint: pk(11), tokenProgram: pk(12), escrow: pk(13), collateralReserve: pk(14), bountyReserve: pk(15),
    fridayTargetTs: 1_000_000_000n, mondayTargetTs: 1_000_000_601n, buyingCloseTs: 1_000_000_600n, maxContracts: 200,
    dealerQuoteKey: PublicKey.default, quoteMaxLifetimeS: 90n, sandbox: false, demoAuthority: PublicKey.default, sandboxMode: "gap",
    state: "FridayFinal", friday: { price: 20_000_000n, feedTsUs: 1_000_000_000_000_000n, submitter: pk(1) }, monday: null,
    contractsSold: 0, totalPremiums: 0n, openPositions: 0, buyingClosed: false, ...o,
  };
}
const ref = (price: number, roundTripBps = 20) => ({ price, roundTripBps, multiplier: 1, decimals: 8 });

function quoter(o: { mk?: Partial<MarketInfo>; nonce?: () => bigint; freeze?: Freeze; fx?: number; bell?: boolean } = {}) {
  const key = Keypair.generate();
  const freeze = o.freeze ?? (() => { const f = new Freeze(); f.update(ref(200), NOW_S * 1000); return f; })();
  const q = new Quoter({
    readMarket: async () => market({ dealerQuoteKey: key.publicKey, ...o.mk }),
    readLastNonce: async () => (o.nonce ? o.nonce() : 0n),
    freeze,
    fridayRef: () => o.fx ?? 200,
    gaps: [0.02],
    quoteKey: key,
    nowMs: () => NOW_S * 1000,
    bellRung: () => o.bell ?? false,
  });
  return { q, key };
}

describe("Quoter", () => {
  it("prices with the section 7 formula and signs a 60 s quote", async () => {
    const { q, key } = quoter();
    const r = await q.quote(pk(1), pk(2), 10);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quote.premiumPerContract).toBe(319_500n);
    expect(r.quote.expiry).toBe(BigInt(NOW_S + 60));
    expect(r.quote.nonce).toBe(1n);
    expect(verifyEd25519(key.publicKey, r.message, r.signature)).toBe(true);
  });
  it("nonce is Position.last_nonce + 1 and refreshes reuse it until a buy lands", async () => {
    let last = 0n;
    const { q } = quoter({ nonce: () => last });
    const a = await q.quote(pk(1), pk(2), 1);
    const b = await q.quote(pk(1), pk(2), 1);
    expect(a.ok && b.ok && a.quote.nonce === 1n && b.quote.nonce === 1n).toBe(true);
    last = 1n; // a buy succeeded
    const c = await q.quote(pk(1), pk(2), 1);
    expect(c.ok && c.quote.nonce).toBe(2n);
  });
  it("m follows the NVDAx fall since the Friday mark", async () => {
    const f = new Freeze();
    f.update(ref(196), NOW_S * 1000); // 2% fall from 200
    const r = await quoter({ freeze: f }).q.quote(pk(1), pk(2), 1);
    if (!r.ok) throw new Error(r.reason);
    expect(r.inputs.m).toBeCloseTo(0.02, 12);
    expect(r.inputs.base).toBeCloseTo(0.75, 12);
  });
  it("real markets refuse while frozen; sandbox markets price off the last good reference", async () => {
    const f = new Freeze();
    f.update(ref(200), NOW_S * 1000 - 60_000);
    f.update(null, NOW_S * 1000); // no route
    expect(await quoter({ freeze: f }).q.quote(pk(1), pk(2), 1)).toMatchObject({ ok: false });
    const s = await quoter({ freeze: f, mk: { sandbox: true, friday: { price: 1n, feedTsUs: BigInt(NOW_S - 10) * 1_000_000n, submitter: pk(1) } } }).q.quote(pk(1), pk(2), 1);
    expect(s.ok).toBe(true);
  });
  it("refuses after buying closes, at the sandbox 10-minute cap, after the bell, over capacity, or at 0.95+", async () => {
    expect((await quoter({ mk: { buyingClosed: true } }).q.quote(pk(1), pk(2), 1)).ok).toBe(false);
    expect((await quoter({ mk: { buyingCloseTs: BigInt(NOW_S) } }).q.quote(pk(1), pk(2), 1)).ok).toBe(false);
    expect((await quoter({ mk: { state: "Created" } }).q.quote(pk(1), pk(2), 1)).ok).toBe(false);
    const old = { price: 1n, feedTsUs: BigInt(NOW_S - 600) * 1_000_000n, submitter: pk(1) };
    expect((await quoter({ mk: { sandbox: true, friday: old } }).q.quote(pk(1), pk(2), 1)).ok).toBe(false);
    const fresh = { ...old, feedTsUs: BigInt(NOW_S - 599) * 1_000_000n };
    expect((await quoter({ mk: { sandbox: true, friday: fresh } }).q.quote(pk(1), pk(2), 1)).ok).toBe(true);
    expect((await quoter({ mk: { sandbox: true, friday: fresh }, bell: true }).q.quote(pk(1), pk(2), 1)).ok).toBe(false);
    expect((await quoter({ mk: { contractsSold: 195 } }).q.quote(pk(1), pk(2), 6)).ok).toBe(false);
    expect((await quoter().q.quote(pk(1), pk(2), 0)).ok).toBe(false);
    expect((await quoter({ fx: 220 }).q.quote(pk(1), pk(2), 1)).ok).toBe(false); // m = 9%: premium above 0.95
  });
});

/* ---------- Sandbox ---------- */

function fakeChain(mode: "gap" | "multiplierVoid") {
  const log: string[] = [];
  let mk = market({ sandbox: true, sandboxMode: mode });
  const chain: SandboxChain = {
    async createSandboxMarket(_m, fridayPrice) {
      log.push(`create ${fridayPrice}`);
      mk = { ...mk, friday: { price: fridayPrice, feedTsUs: 0n, submitter: pk(1) } };
      return pk(42);
    },
    async readMarket() { return mk; },
    async submitMondayPrice(_m, price) {
      log.push(`monday ${price}`);
      mk = { ...mk, buyingClosed: true, monday: { price, feedTsUs: 0n, submitter: pk(1) } };
    },
    async finaliseMonday() { log.push("finalise"); mk = { ...mk, state: mode === "gap" ? "MondayFinal" : "Voided" }; },
    async changeMultiplier() { log.push("multiplier"); },
  };
  return { chain, log };
}

describe("Sandbox", () => {
  it("draws the Monday fall only when the bell rings, after quoting stops", async () => {
    const { chain, log } = fakeChain("gap");
    let draws = 0;
    let rungAtDraw: boolean | null = null;
    const sb: Sandbox = new Sandbox(chain, {
      reference: () => ref(200),
      recordFridayRef: () => {},
      rng: () => { draws++; rungAtDraw = sb.bellRung(pk(42)); return 0.5; },
    });
    const { market: m, fridayPrice } = await sb.start("gap");
    expect(fridayPrice).toBe(20_000_000n);
    expect(draws).toBe(0);
    expect(sb.bellRung(m)).toBe(false);
    const r = await sb.bell(m);
    expect(draws).toBe(1);
    expect(rungAtDraw).toBe(true);
    expect(r.fallBps).toBe(250);
    expect(r.mondayPrice).toBe(19_500_000n);
    expect(log).toEqual(["create 20000000", "monday 19500000", "finalise"]);
    await expect(sb.bell(m)).rejects.toThrow(/already rung/);
  });
  it("picks each of 0.5%, 2.5% and 6%", async () => {
    const seen = [];
    for (const x of [0, 0.4, 0.99]) {
      const sb = new Sandbox(fakeChain("gap").chain, { reference: () => null, recordFridayRef: () => {}, rng: () => x });
      await sb.start("gap");
      seen.push((await sb.bell(pk(42))).fallBps);
    }
    expect(seen).toEqual([50, 250, 600]);
  });
  it("multiplier-void mode changes the multiplier before the Monday price, with no fall", async () => {
    const { chain, log } = fakeChain("multiplierVoid");
    const sb = new Sandbox(chain, { reference: () => ref(200), recordFridayRef: () => {}, rng: () => { throw new Error("no draw"); } });
    await sb.start("multiplierVoid");
    const r = await sb.bell(pk(42));
    expect(r.fallBps).toBeNull();
    expect(log).toEqual(["create 20000000", "multiplier", "monday 20000000", "finalise"]);
  });
  it("refuses a bell on a real market", async () => {
    const { chain } = fakeChain("gap");
    const sb = new Sandbox(chain, { reference: () => null, recordFridayRef: () => {} });
    await sb.start("gap");
    chain.readMarket = async () => market({ sandbox: false });
    await expect(sb.bell(pk(42))).rejects.toThrow(/not a sandbox/);
  });
  it("refuses a bell on a market this service did not start, before reading or signing anything", async () => {
    const { chain, log } = fakeChain("multiplierVoid");
    let reads = 0;
    chain.readMarket = async () => { reads++; return market({ sandbox: true, sandboxMode: "multiplierVoid" }); };
    const sb = new Sandbox(chain, { reference: () => null, recordFridayRef: () => {} });
    await expect(sb.bell(pk(77))).rejects.toThrow(/not a sandbox market this service started/);
    expect(reads).toBe(0);
    expect(log).toEqual([]);
  });
  it("devnet adapter reads a look-alike account owned by another program as no market, so the bell refuses", async () => {
    const data = await new BorshAccountsCoder(idl).encode("Market", marketFields({ sandboxMode: { MultiplierVoid: {} } }));
    const programId = pk(50);
    const conn = { getAccountInfo: async () => ({ data, owner: pk(51), lamports: 1, executable: false }) } as any;
    const chain = devnetSandboxChain({ conn, programId, dealer: Keypair.generate(), demo: Keypair.generate(), quoteKey: pk(16), usdcMint: pk(11), nvdaxMint: pk(10) });
    expect(await chain.readMarket(pk(42))).toBeNull();
    let multiplier = 0;
    chain.changeMultiplier = async () => { multiplier++; };
    const sb = new Sandbox(chain, { reference: () => null, recordFridayRef: () => {}, created: new Set([pk(42).toBase58()]) });
    await expect(sb.bell(pk(42))).rejects.toThrow(/not a sandbox market/);
    expect(multiplier).toBe(0);
    // Owned by gap_cover, the same bytes decode.
    const owned = devnetSandboxChain({ conn: { getAccountInfo: async () => ({ data, owner: programId }) } as any, programId, dealer: Keypair.generate(), demo: Keypair.generate(), quoteKey: pk(16), usdcMint: pk(11), nvdaxMint: pk(10) });
    expect((await owned.readMarket(pk(42)))?.sandbox).toBe(true);
  });
});
