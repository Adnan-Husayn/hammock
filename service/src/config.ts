import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FEED_ID = 1314;
export const EXPONENT = -5;
export const ELIGIBILITY_HALF_WINDOW_US = 5_000_000n;
// Provisional until Task 0 step 5 writes the measured caps here. Used when creating markets only: the
// keeper and archive read caps and min publishers from the on-chain Market.
export const CONF_CAP_BPS = { friday: 10, monday: 20 } as const;
export const MIN_PUBLISHERS = 10;
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
