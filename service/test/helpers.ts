import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStreamMessage, type SignedUpdate } from "../src/pyth.ts";
import type { EligibilityParams } from "../src/archive.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "pyth");
export const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));
export const regular = () => parseStreamMessage(fixture("regular-2026-10-29"))!;
export const premarket = () => parseStreamMessage(fixture("premarket-2026-10-29"))!;
export const TS = regular().feedTsUs; // 1_793_280_669_400_000

export const PARAMS: EligibilityParams = { feedId: 1314, exponent: -5, halfWindowUs: 5_000_000n, confCapBps: 10, minPublishers: 10 };

/** A fresh regular update derived from the fixture, with a unique hash. */
export function upd(feedTsUs: bigint, over: Partial<SignedUpdate> = {}): SignedUpdate {
  return { ...regular(), feedTsUs, timestampUs: feedTsUs, hash: `h-${feedTsUs}-${Math.random()}`, ...over };
}
