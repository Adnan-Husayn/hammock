import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every Pyth Pro Equity.US.<SYM>/USD feed uses this exponent; the program accepts only this one in this release. */
export const EXPONENT = -5;
export const ELIGIBILITY_HALF_WINDOW_US = 5_000_000n;

export type MarketConfig = {
  symbol: string;
  /** Pyth Pro feed id, Equity.US.<SYM>/USD. */
  feedId: number;
  /** Mainnet xStocks token, for the Jupiter reference price. */
  mainnetMint: string;
  /** Weekend gap history for pricing, under service/data. */
  gapsFile: string;
  /** Per-leg confidence caps and the publisher minimum written into new markets. */
  confCapBps: { friday: number; monday: number };
  minPublishers: number;
  enabled: boolean;
};

/**
 * Markets the service can run. The devnet test mint for each symbol lives in config/devnet.json (testMints).
 *
 * Caps are PROVISIONAL, from plan Task 0 step 5 applied to the logger data available on 3 Nov 2026 (one weekday for
 * most symbols, two close legs for NVDA): per leg, cap = max(provisional, ceil(1.5 * p95 of daily p95)) with
 * provisionals Friday (close leg) 10 and Monday (open leg) 20; min_publishers = 10 unless an observed minimum is below
 * 10, then observed_min - 1. Recompute from data/marks.csv after five weekdays and update these values. The keeper
 * and archive read caps from the on-chain Market, so a change here only affects markets created afterwards.
 */
export const MARKETS: readonly MarketConfig[] = [
  { symbol: "NVDA", feedId: 1314, mainnetMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", gapsFile: "nvda-gaps.csv", confCapBps: { friday: 10, monday: 20 }, minPublishers: 10, enabled: true },
  // TSLA open-leg p95 was 44.27 bps on 2 Nov: 1.5 * 44.27 -> 67. Close leg 10.37 -> 16.
  { symbol: "TSLA", feedId: 1435, mainnetMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", gapsFile: "tsla-gaps.csv", confCapBps: { friday: 16, monday: 67 }, minPublishers: 10, enabled: true },
  { symbol: "SPY", feedId: 1398, mainnetMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", gapsFile: "spy-gaps.csv", confCapBps: { friday: 10, monday: 20 }, minPublishers: 10, enabled: true },
  { symbol: "AAPL", feedId: 922, mainnetMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", gapsFile: "aapl-gaps.csv", confCapBps: { friday: 10, monday: 20 }, minPublishers: 10, enabled: true },
  // Later. No gap files yet: run node scripts/build-gaps.mjs GOOGL MSFT META QQQ AMZN before enabling.
  { symbol: "GOOGL", feedId: 1163, mainnetMint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", gapsFile: "googl-gaps.csv", confCapBps: { friday: 10, monday: 20 }, minPublishers: 10, enabled: false },
  { symbol: "MSFT", feedId: 1292, mainnetMint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", gapsFile: "msft-gaps.csv", confCapBps: { friday: 12, monday: 20 }, minPublishers: 10, enabled: false },
  { symbol: "META", feedId: 1272, mainnetMint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", gapsFile: "meta-gaps.csv", confCapBps: { friday: 10, monday: 28 }, minPublishers: 10, enabled: false },
  // QQQ close leg saw 9 publishers, so its minimum is 8.
  { symbol: "QQQ", feedId: 1363, mainnetMint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", gapsFile: "qqq-gaps.csv", confCapBps: { friday: 10, monday: 20 }, minPublishers: 8, enabled: false },
  { symbol: "AMZN", feedId: 954, mainnetMint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", gapsFile: "amzn-gaps.csv", confCapBps: { friday: 10, monday: 22 }, minPublishers: 10, enabled: false },
];

export const DEFAULT_SYMBOL = "NVDA";
/** NVDA's feed, the default where one feed is implied (fixtures, old archive lines). */
export const FEED_ID = 1314;

/** Enabled markets: ENABLED_SYMBOLS (comma list) when set, otherwise the `enabled` flags above. */
export function enabledMarkets(env: NodeJS.ProcessEnv = process.env): MarketConfig[] {
  const list = env.ENABLED_SYMBOLS?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!list?.length) return MARKETS.filter((m) => m.enabled);
  return list.map((s) => {
    const m = MARKETS.find((x) => x.symbol === s);
    if (!m) throw new Error(`ENABLED_SYMBOLS names unknown symbol ${s}`);
    return m;
  });
}

export function marketBySymbol(symbol: string): MarketConfig | undefined {
  return MARKETS.find((m) => m.symbol === symbol.toUpperCase());
}

export function marketByFeed(feedId: number): MarketConfig | undefined {
  return MARKETS.find((m) => m.feedId === feedId);
}

/** The devnet test mint for a symbol from config/devnet.json; NVDA falls back to the older nvdaxTest entry. */
export function devnetTestMint(devnet: any, symbol: string): string | undefined {
  return devnet?.testMints?.[symbol]?.mint ?? (symbol === "NVDA" ? devnet?.nvdaxTest?.mint : undefined);
}
// Keeper timing (spec section 6): first submit at T + 2 s, finalise after T + 7 min.
export const SUBMIT_START_US = 2_000_000n;
export const SUBMISSION_WINDOW_US = 420_000_000n;

export const PYTH_ENDPOINTS = [0, 1, 2].map((i) => `wss://pyth-lazer-${i}.dourolabs.app/v1/stream`);

export const LAZER_PROGRAM_ID = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
export const LAZER_STORAGE = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
export const LAZER_TREASURY = "opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7";

function devnetFile(): { programId?: string; rpcUrl?: string } {
  const p = join(ROOT, "config", "devnet.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Server-side only: the token never leaves this process and is never logged. */
export function pythToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PYTH_PRO_TOKEN) return env.PYTH_PRO_TOKEN;
  const p = join(ROOT, ".env");
  const m = existsSync(p) ? readFileSync(p, "utf8").match(/^\s*(?:export\s+)?PYTH_PRO_TOKEN\s*=\s*["']?([^"'\r\n]+)/m) : null;
  if (!m) throw new Error("PYTH_PRO_TOKEN missing");
  return m[1].trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const file = devnetFile();
  const programId = env.GAP_COVER_PROGRAM_ID ?? file.programId;
  return {
    rpcUrl: env.SOLANA_RPC_URL ?? file.rpcUrl ?? "https://api.devnet.solana.com",
    programId,
    httpPort: Number(env.SERVICE_PORT ?? 8787),
  };
}

/** The browser origin allowed to call the service. Production must name it; anywhere else defaults to any origin. */
export function corsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CORS_ORIGIN?.trim();
  if (env.NODE_ENV === "production" && (!v || v === "*")) throw new Error("CORS_ORIGIN must be set to the app origin when NODE_ENV=production");
  return v || "*";
}
