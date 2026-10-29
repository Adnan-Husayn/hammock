import { Ed25519Program, PublicKey, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { Freeze, priceBreakdown, BASE_UNITS, MAX_PREMIUM } from "./pricing.ts";
import type { Reference } from "./jupiter.ts";

// Task 6 layout, 96 bytes LE: "MGCQ" | market | buyer | contracts u32 | premium_per_contract u64 | expiry i64 | nonce u64.
export const QUOTE_LEN = 96;
export const QUOTE_MAGIC = Buffer.from("MGCQ");
/** Offsets check_inline_ed25519 requires: public key, signature, message, all instruction indices u16::MAX. */
export const INLINE_PK = 16;
export const INLINE_SIG = 48;
export const INLINE_MSG = 112;
/** On-chain cap is 90 s; quotes expire 60 s out so clock skew and confirmation time stay inside it. */
export const QUOTE_TTL_S = 60;
export const SANDBOX_BUYING_S = 600;

export type Quote = {
  market: PublicKey;
  buyer: PublicKey;
  contracts: number;
  premiumPerContract: bigint; // USDC base units
  expiry: bigint; // unix seconds
  nonce: bigint;
};

export function encodeQuote(q: Quote): Buffer {
  const b = Buffer.alloc(QUOTE_LEN);
  QUOTE_MAGIC.copy(b, 0);
  q.market.toBuffer().copy(b, 4);
  q.buyer.toBuffer().copy(b, 36);
  b.writeUInt32LE(q.contracts, 68);
  b.writeBigUInt64LE(q.premiumPerContract, 72);
  b.writeBigInt64LE(q.expiry, 80);
  b.writeBigUInt64LE(q.nonce, 88);
  return b;
}

/** Signs a quote with the dealer quote key. `instruction` goes at transaction index 0, `buy` at index 1. */
export function signQuote(q: Quote, dealerKey: Keypair): { message: Buffer; signature: Buffer; instruction: TransactionInstruction } {
  const message = encodeQuote(q);
  const instruction = Ed25519Program.createInstructionWithPrivateKey({ privateKey: dealerKey.secretKey, message });
  const d = instruction.data;
  // Guard the layout the program checks so a library change cannot silently produce unbuyable quotes.
  if (d.readUInt16LE(6) !== INLINE_PK || d.readUInt16LE(2) !== INLINE_SIG || d.readUInt16LE(10) !== INLINE_MSG || d.length !== INLINE_MSG + QUOTE_LEN) {
    throw new Error("unexpected Ed25519 instruction layout");
  }
  return { message, signature: Buffer.from(d.subarray(INLINE_SIG, INLINE_SIG + 64)), instruction };
}

/* ---------- on-chain account decoding (Anchor/Borsh, see programs/gap_cover/src/state.rs) ---------- */

export const MARKET_STATES = ["Created", "FridayFinal", "MondayFinal", "Voided"] as const;
export type MarketState = (typeof MARKET_STATES)[number];
export type Candidate = { price: bigint; feedTsUs: bigint; submitter: PublicKey };

export type MarketInfo = {
  dealer: PublicKey;
  nvdaxMint: PublicKey;
  usdcMint: PublicKey;
  tokenProgram: PublicKey;
  escrow: PublicKey;
  collateralReserve: PublicKey;
  bountyReserve: PublicKey;
  fridayTargetTs: bigint;
  mondayTargetTs: bigint;
  buyingCloseTs: bigint;
  maxContracts: number;
  dealerQuoteKey: PublicKey;
  quoteMaxLifetimeS: bigint;
  sandbox: boolean;
  demoAuthority: PublicKey;
  sandboxMode: "gap" | "multiplierVoid";
  state: MarketState;
  friday: Candidate | null;
  monday: Candidate | null;
  contractsSold: number;
  totalPremiums: bigint;
  openPositions: number;
  buyingClosed: boolean;
};

export const MARKET_DISC = Buffer.from([219, 190, 213, 55, 0, 227, 198, 154]);
export const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

class Reader {
  o = 8;
  private b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  pk() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  u8() { return this.b.readUInt8(this.o++); }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  bool() { return this.u8() !== 0; }
  skip(n: number) { this.o += n; }
  cand(): Candidate | null { return this.bool() ? { price: this.i64(), feedTsUs: this.i64(), submitter: this.pk() } : null; }
}

export function decodeMarket(data: Buffer): MarketInfo {
  if (!data.subarray(0, 8).equals(MARKET_DISC)) throw new Error("not a Market account");
  const r = new Reader(data);
  const dealer = r.pk();
  r.skip(1 + 1 + 4 + 2); // bump, vault_bump, feed_id, exponent
  const nvdaxMint = r.pk(), usdcMint = r.pk(), tokenProgram = r.pk(), escrow = r.pk(), collateralReserve = r.pk(), bountyReserve = r.pk();
  const fridayTargetTs = r.i64() / 1_000_000n, mondayTargetTs = r.i64() / 1_000_000n, buyingCloseTs = r.i64();
  r.skip(2 * 5 + 8 + 8); // bands, conf caps, min publishers, half window, submission window
  const maxContracts = r.u32();
  r.skip(8 + 8); // bounty, claim deadline
  const dealerQuoteKey = r.pk();
  const quoteMaxLifetimeS = r.i64();
  const sandbox = r.bool();
  const demoAuthority = r.pk();
  const sandboxMode = r.u8() === 0 ? "gap" : "multiplierVoid";
  r.skip(8 + 8); // creation multiplier, created_at
  const state = MARKET_STATES[r.u8()];
  const friday = r.cand(), monday = r.cand();
  const contractsSold = r.u32(), totalPremiums = r.u64(), openPositions = r.u32();
  r.skip(1 + 8); // swept, payout
  const buyingClosed = r.bool();
  return {
    dealer, nvdaxMint, usdcMint, tokenProgram, escrow, collateralReserve, bountyReserve, fridayTargetTs, mondayTargetTs, buyingCloseTs,
    maxContracts, dealerQuoteKey, quoteMaxLifetimeS, sandbox, demoAuthority, sandboxMode, state, friday, monday, contractsSold,
    totalPremiums, openPositions, buyingClosed,
  };
}

/** Position.last_nonce, or 0 when the buyer has no position yet (the program then expects nonce 1). */
export function decodeLastNonce(data: Buffer | null | undefined): bigint {
  if (!data) return 0n;
  if (!data.subarray(0, 8).equals(POSITION_DISC)) throw new Error("not a Position account");
  return data.readBigUInt64LE(8 + 4 + 8);
}

export const positionPda = (programId: PublicKey, market: PublicKey, buyer: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), buyer.toBuffer()], programId)[0];

export async function readMarket(conn: Connection, market: PublicKey): Promise<MarketInfo | null> {
  const a = await conn.getAccountInfo(market, "confirmed");
  return a ? decodeMarket(a.data) : null;
}

export async function readLastNonce(conn: Connection, programId: PublicKey, market: PublicKey, buyer: PublicKey): Promise<bigint> {
  const a = await conn.getAccountInfo(positionPda(programId, market, buyer), "confirmed");
  return a && a.owner.equals(programId) ? decodeLastNonce(a.data) : 0n;
}

/* ---------- quoting ---------- */

export type QuoterDeps = {
  readMarket(market: PublicKey): Promise<MarketInfo | null>;
  readLastNonce(market: PublicKey, buyer: PublicKey): Promise<bigint>;
  freeze: Freeze;
  /** f_x: the NVDAx reference recorded when the market's Friday mark finalised. */
  fridayRef(market: PublicKey): number | undefined;
  gaps: readonly number[];
  quoteKey: Keypair;
  nowMs(): number;
  /** Sandbox markets whose Monday bell was rung: no more quotes. */
  bellRung?(market: PublicKey): boolean;
};

export type QuoteResult =
  | {
      ok: true;
      quote: Quote;
      message: Buffer;
      signature: Buffer;
      instruction: TransactionInstruction;
      inputs: { fridayRef: number | null; price: number | null; roundTripBps: number | null; m: number; sold: number; max: number } & ReturnType<typeof priceBreakdown>;
    }
  | { ok: false; reason: string };

export class Quoter {
  private d: QuoterDeps;
  constructor(d: QuoterDeps) {
    this.d = d;
  }

  async quote(market: PublicKey, buyer: PublicKey, contracts: number): Promise<QuoteResult> {
    const now = this.d.nowMs();
    const nowS = BigInt(Math.floor(now / 1000));
    const mk = await this.d.readMarket(market);
    if (!mk) return { ok: false, reason: "market not found" };
    if (!mk.dealerQuoteKey.equals(this.d.quoteKey.publicKey)) return { ok: false, reason: "market uses another quote key" };
    if (mk.state !== "FridayFinal" || mk.buyingClosed || nowS >= mk.buyingCloseTs) return { ok: false, reason: "buying closed" };
    if (mk.sandbox) {
      if (this.d.bellRung?.(market)) return { ok: false, reason: "buying closed" };
      const fridayS = (mk.friday?.feedTsUs ?? 0n) / 1_000_000n;
      if (nowS >= fridayS + BigInt(SANDBOX_BUYING_S)) return { ok: false, reason: "buying closed" };
    }
    if (!Number.isInteger(contracts) || contracts < 1) return { ok: false, reason: "contracts must be a positive integer" };
    if (mk.contractsSold + contracts > mk.maxContracts) return { ok: false, reason: "not enough capacity" };

    // Real markets obey the freeze. Sandbox markets ignore it and fall back to the last good reference.
    let ref: Reference | null;
    if (mk.sandbox) ref = this.d.freeze.current ?? this.d.freeze.lastGood;
    else {
      if (this.d.freeze.isFrozen(now)) return { ok: false, reason: "quotes paused by the freeze rule" };
      ref = this.d.freeze.current;
    }
    const fx = this.d.fridayRef(market);
    let m = 0;
    if (ref && fx) m = (fx - ref.price) / fx;
    else if (!mk.sandbox) return { ok: false, reason: "no Friday reference price recorded" };

    const inputs = { gaps: this.d.gaps, m, sold: mk.contractsSold, max: mk.maxContracts };
    const b = priceBreakdown(inputs);
    if (b.units >= MAX_PREMIUM * BASE_UNITS) return { ok: false, reason: "premium would be 0.95 or more" };

    const lifetime = mk.quoteMaxLifetimeS < BigInt(QUOTE_TTL_S) ? mk.quoteMaxLifetimeS : BigInt(QUOTE_TTL_S);
    const quote: Quote = {
      market,
      buyer,
      contracts,
      premiumPerContract: BigInt(b.units),
      expiry: nowS + lifetime,
      // A refreshed quote reuses the same nonce until a buy succeeds and moves last_nonce.
      nonce: (await this.d.readLastNonce(market, buyer)) + 1n,
    };
    const signed = signQuote(quote, this.d.quoteKey);
    return {
      ok: true,
      quote,
      ...signed,
      inputs: { fridayRef: fx ?? null, price: ref?.price ?? null, roundTripBps: ref?.roundTripBps ?? null, m, sold: mk.contractsSold, max: mk.maxContracts, ...b },
    };
  }
}
