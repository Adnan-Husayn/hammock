import { Keypair, PublicKey, SystemProgram, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createUpdateMultiplierDataInstruction, getAssociatedTokenAddressSync, ExtensionType, getMintLen,
  createInitializeScaledUiAmountConfigInstruction, createInitializeMintInstruction,
} from "@solana/spl-token";
import { readMarket as readGapMarket, type MarketInfo } from "./quote.ts";
import type { Reference } from "./jupiter.ts";

export type SandboxMode = "gap" | "multiplierVoid";
/** Monday falls a gap-mode sandbox picks from, in bps (spec section 10). */
export const SANDBOX_FALLS_BPS = [150, 250, 400, 600] as const; // every fall pays, so a first try never shows $0
export const SANDBOX_MAX_CONTRACTS = 200;
/** Friday price when no NVDAx reference has ever been seen, exponent -5. */
export const FALLBACK_FRIDAY_PRICE = 180_00000n;

export interface SandboxChain {
  /** Create a sandbox market and set its Friday price in one transaction (market goes straight to FridayFinal). */
  createSandboxMarket(mode: SandboxMode, fridayPrice: bigint): Promise<PublicKey>;
  readMarket(market: PublicKey): Promise<MarketInfo | null>;
  /** submit_sandbox_price(Monday): closes buying on chain. */
  submitMondayPrice(market: PublicKey, price: bigint): Promise<void>;
  finaliseMonday(market: PublicKey): Promise<void>;
  /** Change a void-mode market's own test mint now. Only called for markets this service created, so one judge cannot void another's market. */
  changeMultiplier(mint: PublicKey): Promise<void>;
}

export type SandboxDeps = {
  reference(): Reference | null;
  recordFridayRef(market: PublicKey, price: number): void;
  /** Markets this service created via start(); the bell acts on nothing else. Defaults to an in-memory set. */
  created?: { has(market: string): boolean; add(market: string): void };
  rng?: () => number;
};

export class Sandbox {
  private rung = new Set<string>();
  private created: { has(market: string): boolean; add(market: string): void };
  private rng: () => number;

  private chain: SandboxChain;
  private d: SandboxDeps;

  constructor(chain: SandboxChain, d: SandboxDeps) {
    this.chain = chain;
    this.d = d;
    this.rng = d.rng ?? Math.random;
    this.created = d.created ?? new Set<string>();
  }

  bellRung(market: PublicKey): boolean {
    return this.rung.has(market.toBase58());
  }

  async start(mode: SandboxMode): Promise<{ market: PublicKey; fridayPrice: bigint; mode: SandboxMode }> {
    const ref = this.d.reference();
    const fridayPrice = ref ? BigInt(Math.round(ref.price * 1e5)) : FALLBACK_FRIDAY_PRICE;
    const market = await this.chain.createSandboxMarket(mode, fridayPrice);
    this.created.add(market.toBase58());
    this.d.recordFridayRef(market, ref ? ref.price : Number(fridayPrice) / 1e5);
    return { market, fridayPrice, mode };
  }

  /**
   * "Ring the Monday bell". Quotes stop first, then (gap mode) the fall is drawn and the Monday price submitted,
   * which closes buying on chain in the same instruction, then the market finalises. No fall exists before this
   * call, so nobody can buy knowing the result. In multiplier-void mode the test mint's multiplier changes first and
   * the Monday price equals the Friday price, so finalise_monday voids.
   */
  async bell(market: PublicKey): Promise<{ mode: SandboxMode; fallBps: number | null; mondayPrice: bigint }> {
    const key = market.toBase58();
    if (!this.created.has(key)) throw new Error("not a sandbox market this service started");
    const mk = await this.chain.readMarket(market);
    if (!mk || !mk.sandbox) throw new Error("not a sandbox market");
    if (mk.state !== "FridayFinal" || mk.monday || !mk.friday) throw new Error("bell already rung");
    if (this.rung.has(key)) throw new Error("bell already rung");
    this.rung.add(key); // buying is closed for quoting from here on

    const friday = mk.friday.price;
    let fallBps: number | null = null;
    let mondayPrice = friday;
    if (mk.sandboxMode === "gap") {
      fallBps = SANDBOX_FALLS_BPS[Math.min(SANDBOX_FALLS_BPS.length - 1, Math.floor(this.rng() * SANDBOX_FALLS_BPS.length))];
      mondayPrice = (friday * BigInt(10_000 - fallBps)) / 10_000n;
    } else {
      await this.chain.changeMultiplier(mk.nvdaxMint);
    }
    await this.chain.submitMondayPrice(market, mondayPrice);
    await this.chain.finaliseMonday(market);
    return { mode: mk.sandboxMode, fallBps, mondayPrice };
  }
}

/* ---------- devnet adapter ---------- */

const IX = {
  create_market: [103, 226, 97, 235, 200, 188, 251, 254],
  submit_sandbox_price: [91, 134, 94, 155, 48, 56, 142, 219],
  finalise_monday: [190, 173, 33, 114, 145, 251, 234, 192],
};
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

export type DevnetSetup = {
  conn: Connection;
  programId: PublicKey;
  dealer: Keypair; // creates markets, funds reserves, holds test mint and multiplier authority
  demo: Keypair; // demo authority
  quoteKey: PublicKey;
  usdcMint: PublicKey;
  nvdaxMint: PublicKey;
};

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await conn.sendRawTransaction(tx.serialize());
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`transaction failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

export type MarketParams = {
  fridayTargetTs: bigint; // unix seconds, UTC
  mondayTargetTs: bigint;
  buyingCloseTs: bigint;
  fridayConfCapBps: number;
  mondayConfCapBps: number;
  minPublishers: number;
  maxContracts: number;
  quoteKey: PublicKey;
  sandbox: boolean;
  demoAuthority: PublicKey; // PublicKey.default on real markets
  mode: SandboxMode;
};

/** Band and bounty are fixed by the program for every market (spec section 6). */
export const BAND_LOWER_BPS = 100;
export const BAND_UPPER_BPS = 500;
export const BOUNTY_PER_LEG = 100_000n;

/** Borsh MarketParams (programs/gap_cover/src/instructions/create_market.rs). */
export function encodeMarketParams(p: MarketParams): Buffer {
  return Buffer.concat([
    i64(p.fridayTargetTs), i64(p.mondayTargetTs), i64(p.buyingCloseTs),
    u16(BAND_LOWER_BPS), u16(BAND_UPPER_BPS), u16(p.fridayConfCapBps), u16(p.mondayConfCapBps), u16(p.minPublishers),
    u32(p.maxContracts), i64(BOUNTY_PER_LEG),
    p.quoteKey.toBuffer(), Buffer.from([p.sandbox ? 1 : 0]), p.demoAuthority.toBuffer(), Buffer.from([p.mode === "gap" ? 0 : 1]),
  ]);
}

/** Borsh MarketParams for a sandbox market. */
export function encodeSandboxParams(now: bigint, mode: SandboxMode, quoteKey: PublicKey, demo: PublicKey): Buffer {
  return encodeMarketParams({
    fridayTargetTs: now, mondayTargetTs: now + 601n, buyingCloseTs: now + 600n, // the program also caps sandbox buying at 600 s
    fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10, maxContracts: SANDBOX_MAX_CONTRACTS,
    quoteKey, sandbox: true, demoAuthority: demo, mode,
  });
}

/** Market PDA: seeds [market, dealer, friday_target_ts]. */
export function marketAddress(programId: PublicKey, dealer: PublicKey, fridayTargetTs: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("market"), dealer.toBuffer(), i64(fridayTargetTs)], programId)[0];
}

/** create_market. The dealer pays rent and funds both reserves from its USDC account. */
export function createMarketInstruction(
  programId: PublicKey, dealer: PublicKey, usdcMint: PublicKey, nvdaxMint: PublicKey, fridayTargetTs: bigint, params: Buffer,
): { market: PublicKey; ix: TransactionInstruction } {
  const market = marketAddress(programId, dealer, fridayTargetTs);
  const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer()], programId)[0];
  const ix = {
    programId,
    keys: [
      { pubkey: dealer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: pda("vault"), isSigner: false, isWritable: false },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: nvdaxMint, isSigner: false, isWritable: false },
      { pubkey: pda("escrow"), isSigner: false, isWritable: true },
      { pubkey: pda("collateral"), isSigner: false, isWritable: true },
      { pubkey: pda("bounty"), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(usdcMint, dealer), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(IX.create_market), params]),
  } as TransactionInstruction;
  return { market, ix };
}

export function devnetSandboxChain(s: DevnetSetup): SandboxChain {
  const pda = (seed: string, market: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer()], s.programId)[0];
  const dealerUsdc = getAssociatedTokenAddressSync(s.usdcMint, s.dealer.publicKey);
  const demoUsdc = getAssociatedTokenAddressSync(s.usdcMint, s.demo.publicKey);
  const sandboxPrice = (market: PublicKey, leg: 0 | 1, price: bigint) => ({
    programId: s.programId,
    keys: [
      { pubkey: s.demo.publicKey, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(IX.submit_sandbox_price), Buffer.from([leg]), i64(price)]),
  });
  // Owner-checked: an account not owned by gap_cover reads as null.
  const readMarket = (m: PublicKey) => readGapMarket(s.conn, s.programId, m);

  return {
    readMarket,
    async createSandboxMarket(mode, fridayPrice) {
      // Seeds [market, dealer, friday_target_ts]: one sandbox per second; retry the next second on a clash.
      for (let attempt = 0; attempt < 5; attempt++) {
        const now = BigInt(Math.floor(Date.now() / 1000)) + BigInt(attempt);
        const market = marketAddress(s.programId, s.dealer.publicKey, now);
        if (await s.conn.getAccountInfo(market)) continue;
        const params = encodeSandboxParams(now, mode, s.quoteKey, s.demo.publicKey);
        let nvdax = s.nvdaxMint;
        if (mode === "multiplierVoid") { // its own mint, so ringing this bell cannot void other sandbox markets
          const own = Keypair.generate();
          const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
          await send(s.conn, s.dealer, [
            SystemProgram.createAccount({ fromPubkey: s.dealer.publicKey, newAccountPubkey: own.publicKey, space,
              lamports: await s.conn.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
            createInitializeScaledUiAmountConfigInstruction(own.publicKey, s.dealer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID),
            createInitializeMintInstruction(own.publicKey, 8, s.dealer.publicKey, null, TOKEN_2022_PROGRAM_ID),
          ], [own]);
          nvdax = own.publicKey;
        }
        const { ix: create } = createMarketInstruction(s.programId, s.dealer.publicKey, s.usdcMint, nvdax, now, params);
        await send(s.conn, s.dealer, [create, sandboxPrice(market, 0, fridayPrice) as TransactionInstruction], [s.demo]);
        return market;
      }
      throw new Error("could not pick a fresh sandbox market address");
    },
    async submitMondayPrice(market, price) {
      await send(s.conn, s.dealer, [sandboxPrice(market, 1, price) as TransactionInstruction], [s.demo]);
    },
    async finaliseMonday(market) {
      const mk = await readMarket(market);
      if (!mk) throw new Error("market not found");
      const ix = {
        programId: s.programId,
        keys: [
          { pubkey: s.dealer.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: pda("vault", market), isSigner: false, isWritable: false },
          { pubkey: s.usdcMint, isSigner: false, isWritable: false },
          { pubkey: mk.nvdaxMint, isSigner: false, isWritable: false },
          { pubkey: pda("escrow", market), isSigner: false, isWritable: true },
          { pubkey: pda("collateral", market), isSigner: false, isWritable: true },
          { pubkey: pda("bounty", market), isSigner: false, isWritable: true },
          { pubkey: demoUsdc, isSigner: false, isWritable: true },
          { pubkey: dealerUsdc, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(IX.finalise_monday),
      } as TransactionInstruction;
      await send(s.conn, s.dealer, [
        createAssociatedTokenAccountIdempotentInstruction(s.dealer.publicKey, demoUsdc, s.demo.publicKey, s.usdcMint),
        ix,
      ]);
    },
    async changeMultiplier(mint) {
      const now = BigInt(Math.floor(Date.now() / 1000)) - 5n; // effective immediately
      await send(s.conn, s.dealer, [createUpdateMultiplierDataInstruction(mint, s.dealer.publicKey, 1.01, now, [], TOKEN_2022_PROGRAM_ID)]);
    },
  };
}

export const FAUCET_LAMPORTS = 5_000_000;
/** SOL goes only to a wallet holding less than this; a judge who already has fee SOL gets tokens only. */
export const FAUCET_SOL_BELOW_LAMPORTS = 3_000_000;
/** All wallets together, per rolling hour. */
export const FAUCET_SOL_PER_HOUR_LAMPORTS = 250_000_000;

/** Rolling one-hour cap on SOL the faucet sends, across all wallets. */
export class HourlyCap {
  private sent: { t: number; v: number }[] = [];
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  take(v: number, nowMs: number): boolean {
    this.sent = this.sent.filter((e) => nowMs - e.t < 3_600_000);
    if (this.sent.reduce((a, e) => a + e.v, 0) + v > this.cap) return false;
    this.sent.push({ t: nowMs, v });
    return true;
  }
}

export type FaucetOptions = {
  /** Pays the SOL drip, the fees and the token account rent. Unset: no SOL is sent, and the dealer pays fees and rent. */
  faucetKey?: Keypair | null;
  solCap?: HourlyCap;
  nowMs?: () => number;
  usdc?: bigint;
  nvdax?: bigint;
};

/**
 * Faucet: demo USDC and a little NVDAx (test) to the judge's wallet, plus a little SOL for Position rent when the
 * wallet has almost none. The dealer signs only as mint authority. SOL never comes from the dealer key, because the
 * dealer pays the keeper's reports and finalise calls and must not be drained by fresh wallets.
 */
export async function faucet(s: DevnetSetup, wallet: PublicKey, o: FaucetOptions = {}) {
  const usdc = o.usdc ?? 100_000_000n;
  const nvdax = o.nvdax ?? 100_000_000n;
  const payer = o.faucetKey ?? s.dealer;
  const usdcAta = getAssociatedTokenAddressSync(s.usdcMint, wallet);
  const nvdaxAta = getAssociatedTokenAddressSync(s.nvdaxMint, wallet, false, TOKEN_2022_PROGRAM_ID);
  const ixs: TransactionInstruction[] = [];
  let solLamports = 0;
  if (o.faucetKey && (await s.conn.getBalance(wallet, "confirmed")) < FAUCET_SOL_BELOW_LAMPORTS
    && (o.solCap ?? new HourlyCap(FAUCET_SOL_PER_HOUR_LAMPORTS)).take(FAUCET_LAMPORTS, (o.nowMs ?? Date.now)())) {
    solLamports = FAUCET_LAMPORTS;
    // A buyer pays rent for their Position account, and a fresh judge wallet holds no SOL.
    ixs.push(SystemProgram.transfer({ fromPubkey: o.faucetKey.publicKey, toPubkey: wallet, lamports: FAUCET_LAMPORTS }));
  }
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, usdcAta, wallet, s.usdcMint),
    createMintToInstruction(s.usdcMint, usdcAta, s.dealer.publicKey, usdc),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, nvdaxAta, wallet, s.nvdaxMint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(s.nvdaxMint, nvdaxAta, s.dealer.publicKey, nvdax, [], TOKEN_2022_PROGRAM_ID),
  );
  const signature = await send(s.conn, payer, ixs, [s.dealer]);
  return { signature, solLamports };
}
