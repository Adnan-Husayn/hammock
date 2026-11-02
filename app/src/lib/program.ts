import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// Mirrors idl/gap_cover.json. Kept by hand so the browser bundle does not need Anchor.
export const DEFAULT_PROGRAM_ID = "HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g";
export const USDC_UNITS = 1_000_000;
export const PRICE_EXPONENT = -5;
export const DOLLARS_PER_CONTRACT = 25;
export const BAND_LOWER = 0.01;
export const BAND_WIDTH = 0.04;

const DISC = {
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  market: [219, 190, 213, 55, 0, 227, 198, 154],
  position: [170, 188, 143, 228, 122, 64, 247, 208],
} as const;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/* ---------- payout maths ---------- */

/** USDC per contract for a fall (decimal, 0.02 = 2%): clamp((gap - 1%) / 4%, 0, 1). */
export function payoutPerContract(fall: number): number {
  return Math.min(1, Math.max(0, (fall - BAND_LOWER) / BAND_WIDTH));
}

/** One contract per $25 of the stock token: $5,000 -> 200. */
export function suggestedContracts(holdingUsd: number): number {
  return Math.max(0, Math.floor(holdingUsd / DOLLARS_PER_CONTRACT));
}

/** Net loss in USD: holding loss - payout + premium paid. */
export function netLoss(holdingUsd: number, fall: number, contracts: number, totalPremiumUsd: number): number {
  return holdingUsd * fall - contracts * payoutPerContract(fall) + totalPremiumUsd;
}

/* ---------- account decoding ---------- */

export type MarketState = "Created" | "FridayFinal" | "MondayFinal" | "Voided";
export type Candidate = { price: bigint; feedTsUs: bigint; submitter: PublicKey };

export type MarketInfo = {
  dealer: PublicKey;
  /** Pyth Pro feed id of the stock this market covers. */
  feedId: number;
  usdcMint: PublicKey;
  tokenProgram: PublicKey;
  escrow: PublicKey;
  collateralReserve: PublicKey;
  fridayTargetUs: bigint;
  mondayTargetUs: bigint;
  buyingCloseTs: bigint;
  bandLowerBps: number;
  bandUpperBps: number;
  fridayConfCapBps: number;
  mondayConfCapBps: number;
  minPublishers: number;
  maxContracts: number;
  sandbox: boolean;
  sandboxMode: "gap" | "multiplierVoid";
  state: MarketState;
  friday: Candidate | null;
  monday: Candidate | null;
  contractsSold: number;
  totalPremiums: bigint;
  activePositions: number;
  payoutPerContract: bigint;
  buyingClosed: boolean;
  settledAt: bigint;
};

export type PositionInfo = { contracts: number; premiumPaid: bigint; lastNonce: bigint; closed: boolean };

class Reader {
  o = 8;
  private v: DataView;
  private b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  pk() { const p = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return p; }
  u8() { return this.v.getUint8(this.o++); }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  i16() { const x = this.v.getInt16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  bool() { return this.u8() !== 0; }
  cand(): Candidate | null { return this.bool() ? { price: this.i64(), feedTsUs: this.i64(), submitter: this.pk() } : null; }
}

const hasDisc = (b: Uint8Array, d: readonly number[]) => d.every((x, i) => b[i] === x);

export function decodeMarket(data: Uint8Array): MarketInfo {
  if (!hasDisc(data, DISC.market)) throw new Error("not a Market account");
  const r = new Reader(data);
  const dealer = r.pk();
  r.u8(); r.u8(); // bump, vault_bump
  const feedId = r.u32();
  r.i16(); // exponent
  r.pk(); // stock_mint
  const usdcMint = r.pk(), tokenProgram = r.pk(), escrow = r.pk();
  const collateralReserve = r.pk();
  r.pk(); // bounty_reserve
  const fridayTargetUs = r.i64(), mondayTargetUs = r.i64(), buyingCloseTs = r.i64();
  const bandLowerBps = r.u16(), bandUpperBps = r.u16(), fridayConfCapBps = r.u16(), mondayConfCapBps = r.u16(), minPublishers = r.u16();
  r.i64(); r.i64(); // half window, submission window
  const maxContracts = r.u32();
  r.u64(); r.i64(); // bounty, claim deadline
  r.pk(); r.i64(); // dealer_quote_key, quote_max_lifetime_s
  const sandbox = r.bool();
  r.pk(); // demo_authority
  const sandboxMode = r.u8() === 0 ? "gap" : "multiplierVoid";
  r.u64(); r.i64(); // creation multiplier, created_at
  const state = (["Created", "FridayFinal", "MondayFinal", "Voided"] as const)[r.u8()];
  const friday = r.cand(), monday = r.cand();
  const contractsSold = r.u32(), totalPremiums = r.u64(), activePositions = r.u32();
  r.bool(); // swept
  const payout = r.u64();
  const buyingClosed = r.bool();
  const settledAt = r.i64();
  return {
    dealer, feedId, usdcMint, tokenProgram, escrow, collateralReserve, fridayTargetUs, mondayTargetUs, buyingCloseTs, bandLowerBps, bandUpperBps,
    fridayConfCapBps, mondayConfCapBps, minPublishers, maxContracts, sandbox, sandboxMode, state, friday, monday,
    contractsSold, totalPremiums, activePositions, payoutPerContract: payout, buyingClosed, settledAt,
  };
}

export function decodePosition(data: Uint8Array): PositionInfo {
  if (!hasDisc(data, DISC.position)) throw new Error("not a Position account");
  const r = new Reader(data);
  return { contracts: r.u32(), premiumPaid: r.u64(), lastNonce: r.u64(), closed: r.bool() };
}

/* ---------- addresses ---------- */

export const positionPda = (programId: PublicKey, market: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), owner.toBuffer()], programId)[0];

export const vaultPda = (programId: PublicKey, market: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];

export const ata = (mint: PublicKey, owner: PublicKey, tokenProgram = TOKEN_PROGRAM) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/* ---------- transactions ---------- */

export type BuildCtx = { programId: PublicKey; market: PublicKey; info: MarketInfo; user: PublicKey; feePayer: PublicKey; blockhash: string };

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tx(c: BuildCtx, ixs: TransactionInstruction[]): Transaction {
  const t = new Transaction({ feePayer: c.feePayer, recentBlockhash: c.blockhash });
  t.add(...ixs);
  return t;
}

/** Index 0: the dealer's inline Ed25519 quote instruction, exactly as the service built it. Index 1: buy. */
export function buildBuyTx(c: BuildCtx, ed25519DataB64: string): Transaction {
  const ed = new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.from(b64(ed25519DataB64)) });
  const buy = new TransactionInstruction({
    programId: c.programId,
    data: Buffer.from(DISC.buy),
    keys: [
      { pubkey: c.user, isSigner: true, isWritable: true },
      { pubkey: c.market, isSigner: false, isWritable: true },
      { pubkey: positionPda(c.programId, c.market, c.user), isSigner: false, isWritable: true },
      { pubkey: vaultPda(c.programId, c.market), isSigner: false, isWritable: false },
      { pubkey: c.info.usdcMint, isSigner: false, isWritable: false },
      { pubkey: c.info.escrow, isSigner: false, isWritable: true },
      { pubkey: c.info.collateralReserve, isSigner: false, isWritable: true },
      { pubkey: ata(c.info.usdcMint, c.user, c.info.tokenProgram), isSigner: false, isWritable: true },
      { pubkey: c.info.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
  });
  return tx(c, [ed, buy]);
}

function settleTx(c: BuildCtx, kind: "claim" | "refund"): Transaction {
  const ix = new TransactionInstruction({
    programId: c.programId,
    data: Buffer.from(DISC[kind]),
    keys: [
      { pubkey: c.user, isSigner: true, isWritable: true },
      { pubkey: c.market, isSigner: false, isWritable: true },
      { pubkey: positionPda(c.programId, c.market, c.user), isSigner: false, isWritable: true },
      { pubkey: vaultPda(c.programId, c.market), isSigner: false, isWritable: false },
      { pubkey: c.info.usdcMint, isSigner: false, isWritable: false },
      { pubkey: c.info.escrow, isSigner: false, isWritable: true },
      { pubkey: ata(c.info.usdcMint, c.user, c.info.tokenProgram), isSigner: false, isWritable: true },
      { pubkey: c.info.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
  return tx(c, [ix]);
}

export const buildClaimTx = (c: BuildCtx) => settleTx(c, "claim");
export const buildRefundTx = (c: BuildCtx) => settleTx(c, "refund");

/* ---------- display helpers ---------- */

export const usdc = (units: bigint | number) => Number(units) / USDC_UNITS;
export const price = (raw: bigint) => Number(raw) * 10 ** PRICE_EXPONENT;
export const fmtUsd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtTimeUs = (us: bigint) => new Date(Number(us / 1000n)).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
