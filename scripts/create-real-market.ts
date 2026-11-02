// Dealer tool: creates a real (non-sandbox) market for one stock and one weekend and prints its address for
// REAL_MARKETS. Several stocks share a weekend: the market address includes the feed id.
//
// Usage (from the repository root):
//   DEALER_KEYPAIR=~/deploy-keypair.json [QUOTE_PUBKEY=<key>] [RPC_URL=...] \
//     node scripts/create-real-market.ts <SYMBOL> <YYYY-MM-DD> [--max-contracts 1000] [--dry-run]
//
// SYMBOL is one of service/src/config.ts MARKETS (NVDA, TSLA, SPY, AAPL, ...); its feed id, caps and minimum
// publishers come from there, its test mint from config/devnet.json testMints.
// The date is any trading day of the week whose Friday you want; normally the Friday itself.
// Checks before sending (spec section 4):
//   - Pyth's US equity schedule (fixtures/pyth/symbols-1314.json; the same exchange calendar applies to every US
//     stock): refuses holiday weeks; early-close Fridays get the 12:59:30 ET target.
//   - the stock's test mint: refuses when a multiplier change is scheduled between now and the Monday target.
//   - the Friday target must be at least an hour (plus a margin) away; the program enforces the hour too.
// Buying closes Sunday 17:50 ET (spec section 4, "Buying"). Reserves are funded by create_market itself:
// max_contracts * 1 USDC to collateral and 2 * 0.1 USDC to the bounty reserve, from the dealer's demo USDC.
// --dry-run reads the mint and prints the parameters without sending anything.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getScaledUiAmountConfig, unpackMint } from "@solana/spl-token";
import { etToUtc, scheduleTargets } from "./schedule.ts";
import {
  BOUNTY_PER_LEG, createMarketInstruction, type MarketParams,
} from "../service/src/sandbox.ts";
import { DEFAULT_SYMBOL, devnetTestMint, marketByFeed, marketBySymbol, type MarketConfig } from "../service/src/config.ts";

export const DEFAULT_MAX_CONTRACTS = 1_000;
/** The program's MIN_CREATE_LEAD_S is 3_600; keep a margin for the transaction to land. */
export const CREATE_LEAD_S = 3_600 + 300;
export const BUYING_CLOSE_ET: [number, number] = [17, 50]; // Sunday, New York time

export class Refusal extends Error {}

export type MultiplierState = { multiplier: number; newMultiplier: number; newMultiplierEffectiveTs: bigint };

/** Sunday 17:50 ET before the Monday target. */
export function buyingClose(mondayTargetUtc: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(mondayTargetUtc).split("-").map(Number);
  const sunday = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]) - 86_400_000);
  return etToUtc(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), BUYING_CLOSE_ET[0], BUYING_CLOSE_ET[1], 0);
}

/** Refuses a multiplier change that takes effect after now and at or before the Monday target. */
export function checkMultiplier(m: MultiplierState, nowS: bigint, mondayTs: bigint): void {
  const t = m.newMultiplierEffectiveTs;
  if (t > nowS && t <= mondayTs && m.newMultiplier !== m.multiplier) {
    throw new Refusal(`test mint has a multiplier change (${m.multiplier} -> ${m.newMultiplier}) scheduled at ${new Date(Number(t) * 1000).toISOString()}, before the Monday target`);
  }
}

export type BuildInput = {
  /** Default NVDA. */
  symbol?: string;
  dateEt: string;
  nowS: bigint;
  quoteKey: PublicKey;
  multiplier: MultiplierState;
  maxContracts?: number;
  schedule?: string;
};

/** All checks and the parameters for one real market. Throws Refusal when the market must not be created. */
export function buildRealMarketParams(i: BuildInput): MarketParams {
  const cfg: MarketConfig | undefined = marketBySymbol(i.symbol ?? DEFAULT_SYMBOL);
  if (!cfg) throw new Refusal(`unknown symbol ${i.symbol}`);
  const t = i.schedule === undefined ? scheduleTargets(i.dateEt) : scheduleTargets(i.dateEt, i.schedule);
  if (t === "holiday") throw new Refusal(`the week of ${i.dateEt} has a market holiday on the anchor day, Friday or Monday`);
  const fridayTargetTs = BigInt(Math.floor(t.fridayTargetUtc.getTime() / 1000));
  const mondayTargetTs = BigInt(Math.floor(t.mondayTargetUtc.getTime() / 1000));
  const buyingCloseTs = BigInt(Math.floor(buyingClose(t.mondayTargetUtc).getTime() / 1000));
  if (fridayTargetTs < i.nowS + BigInt(CREATE_LEAD_S)) {
    throw new Refusal(`Friday target ${t.fridayTargetUtc.toISOString()} is less than ${CREATE_LEAD_S} s away; create at least an hour before`);
  }
  checkMultiplier(i.multiplier, i.nowS, mondayTargetTs);
  const maxContracts = i.maxContracts ?? DEFAULT_MAX_CONTRACTS;
  if (!Number.isInteger(maxContracts) || maxContracts <= 0) throw new Refusal("max contracts must be a positive integer");
  return {
    feedId: cfg.feedId, fridayTargetTs, mondayTargetTs, buyingCloseTs,
    fridayConfCapBps: cfg.confCapBps.friday, mondayConfCapBps: cfg.confCapBps.monday, minPublishers: cfg.minPublishers,
    maxContracts, quoteKey: i.quoteKey, sandbox: false, demoAuthority: PublicKey.default, mode: "gap",
  };
}

/** USDC (6 decimals) the dealer needs for the two reserves. */
export const reserveUsdc = (p: MarketParams) => BigInt(p.maxContracts) * 1_000_000n + 2n * BOUNTY_PER_LEG;

export function describeParams(p: MarketParams, market: PublicKey): Record<string, string | number | boolean> {
  const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
  return {
    market: market.toBase58(),
    symbol: marketByFeed(p.feedId)?.symbol ?? "?", feedId: p.feedId,
    fridayTarget: iso(p.fridayTargetTs), mondayTarget: iso(p.mondayTargetTs), buyingClose: iso(p.buyingCloseTs),
    fridayConfCapBps: p.fridayConfCapBps, mondayConfCapBps: p.mondayConfCapBps, minPublishers: p.minPublishers,
    maxContracts: p.maxContracts, reserveUsdc: (Number(reserveUsdc(p)) / 1e6).toFixed(2),
    quoteKey: p.quoteKey.toBase58(), sandbox: p.sandbox,
  };
}

export function readMultiplier(data: Buffer, mint: PublicKey, owner: PublicKey): MultiplierState {
  const c = getScaledUiAmountConfig(unpackMint(mint, { data, owner, lamports: 0, executable: false } as any, TOKEN_2022_PROGRAM_ID));
  if (!c) throw new Refusal("test mint has no ScaledUiAmount extension");
  return { multiplier: c.multiplier, newMultiplier: c.newMultiplier, newMultiplierEffectiveTs: BigInt(c.newMultiplierEffectiveTimestamp) };
}

async function main() {
  const args = process.argv.slice(2);
  const dateEt = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const symbol = args.find((a) => /^[A-Za-z]{1,6}$/.test(a))?.toUpperCase();
  if (!dateEt || !symbol) throw new Error("usage: node scripts/create-real-market.ts <SYMBOL> <YYYY-MM-DD> [--max-contracts N] [--dry-run]");
  if (!marketBySymbol(symbol)) throw new Refusal(`unknown symbol ${symbol}`);
  const dryRun = args.includes("--dry-run");
  const mi = args.indexOf("--max-contracts");
  const maxContracts = mi >= 0 ? Number(args[mi + 1]) : undefined;

  const root = new URL("..", import.meta.url);
  const devnet = JSON.parse(readFileSync(new URL("config/devnet.json", root), "utf8"));
  const programId = new PublicKey(process.env.GAP_COVER_PROGRAM_ID ?? devnet.programId ?? "HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g");
  const keyPath = (process.env.DEALER_KEYPAIR ?? "").replace(/^~/, homedir());
  if (!keyPath) throw new Error("DEALER_KEYPAIR is not set");
  const dealer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const quoteKey = process.env.QUOTE_PUBKEY ? new PublicKey(process.env.QUOTE_PUBKEY) : dealer.publicKey;
  const usdcMint = new PublicKey(devnet.usdcDemo.mint);
  const testMint = devnetTestMint(devnet, symbol);
  if (!testMint) throw new Refusal(`no test mint for ${symbol} in config/devnet.json; run scripts/create-test-mints.ts ${symbol}`);
  const stockMint = new PublicKey(testMint);
  const conn = new Connection(process.env.RPC_URL ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

  const info = await conn.getAccountInfo(stockMint);
  if (!info) throw new Refusal(`${symbol} test mint not found`);
  const p = buildRealMarketParams({
    symbol, dateEt, nowS: BigInt(Math.floor(Date.now() / 1000)), quoteKey, maxContracts,
    multiplier: readMultiplier(info.data, stockMint, info.owner),
  });
  const { market, ix } = createMarketInstruction(programId, dealer.publicKey, usdcMint, stockMint, p);
  console.log(describeParams(p, market));
  if (dryRun) return console.log("dry run: nothing sent");
  if (await conn.getAccountInfo(market)) throw new Refusal(`market ${market.toBase58()} already exists`);

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = dealer.publicKey;
  tx.sign(dealer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`create_market failed: ${JSON.stringify(r.value.err)} (${sig})`);
  console.log(`created ${market.toBase58()} in ${sig}`);
  console.log(`add to REAL_MARKETS: ${market.toBase58()}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e instanceof Refusal ? `refused: ${e.message}` : e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
