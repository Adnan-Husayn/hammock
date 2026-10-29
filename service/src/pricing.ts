import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reference } from "./jupiter.ts";

// Spec section 7. Coefficients are provisional until checked against the backtest.
export const BAND_LOWER = 0.01;
export const BAND_WIDTH = 0.04;
export const UNCERTAINTY_SHARE = 0.25;
export const UNCERTAINTY_FLOOR = 0.005;
export const RESERVE = 0.002;
export const MAX_PREMIUM = 0.95;
export const BASE_UNITS = 1_000_000;

export type PriceInputs = { gaps: readonly number[]; m: number; sold: number; max: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function priceBreakdown({ gaps, m, sold, max }: PriceInputs) {
  if (gaps.length === 0) throw new Error("no historical gaps");
  if (!(max > 0) || sold < 0 || sold > max) throw new Error("bad utilisation inputs");
  const base = gaps.reduce((s, g) => s + clamp01((g + m - BAND_LOWER) / BAND_WIDTH), 0) / gaps.length;
  const uncertainty = UNCERTAINTY_SHARE * base + UNCERTAINTY_FLOOR;
  const u = sold / max;
  const utilisation = base * 2 * u * u;
  const raw = base + uncertainty + utilisation + RESERVE;
  // Round up to the base unit. The 1e-6 slack keeps float noise (0.31950000000000006) from adding a unit.
  const units = Math.ceil(raw * BASE_UNITS - 1e-6);
  return { base, uncertainty, utilisation, reserve: RESERVE, raw, units };
}

/** Premium per contract in USDC, rounded up to the base unit, or null when it would be 0.95 or more (no quote). */
export function premiumPerContract(inputs: PriceInputs): number | null {
  const { units } = priceBreakdown(inputs);
  return units >= MAX_PREMIUM * BASE_UNITS ? null : units / BASE_UNITS;
}

const GAPS_CSV = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "nvda-gaps.csv");

/** Historical weekend gaps (decimals, positive = fall) from the committed CSV. Lines starting with # are notes. */
export function loadGaps(path = GAPS_CSV): number[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const header = lines.shift()!.split(",");
  const col = header.indexOf("gap");
  if (col < 0) throw new Error("nvda-gaps.csv has no gap column");
  return lines.map((l) => Number(l.split(",")[col]));
}

export const FREEZE_MOVE = 0.05;
export const FREEZE_MOVE_WINDOW_MS = 30 * 60_000;
export const FREEZE_MAX_ROUND_TRIP_BPS = 100;
export const FREEZE_LIFT_MS = 15 * 60_000;

/**
 * Freeze rule (spec section 7): no quotes while the NVDAx price moved more than 5% within 30 minutes, the round trip
 * costs more than 100 bps, or Jupiter returned no route. It lifts by itself once 15 minutes pass with none of those
 * true. There is no manual override. Sandbox markets ignore it and price off `lastGood`.
 */
export class Freeze {
  private history: { t: number; price: number }[] = [];
  private lastTrigger: number | null = null;
  private started = false;
  /** Most recent update, or null when the last attempt had no route. */
  current: Reference | null = null;
  /** Most recent reference that came back with a route. */
  lastGood: Reference | null = null;

  update(ref: Reference | null, nowMs: number): void {
    this.started = true;
    this.current = ref;
    this.history = this.history.filter((h) => nowMs - h.t <= FREEZE_MOVE_WINDOW_MS);
    let trigger = ref === null;
    if (ref) {
      this.lastGood = ref;
      if (ref.roundTripBps > FREEZE_MAX_ROUND_TRIP_BPS) trigger = true;
      if (this.history.some((h) => Math.abs(ref.price - h.price) / h.price > FREEZE_MOVE)) trigger = true;
      this.history.push({ t: nowMs, price: ref.price });
    }
    if (trigger) this.lastTrigger = nowMs;
  }

  isFrozen(nowMs: number): boolean {
    if (!this.started || this.current === null) return true;
    return this.lastTrigger !== null && nowMs - this.lastTrigger < FREEZE_LIFT_MS;
  }
}
