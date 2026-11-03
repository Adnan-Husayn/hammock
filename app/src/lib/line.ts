// Payoff line maths. Pure functions so the chart, the replays and the tests share one source.
import { BAND_LOWER, BAND_WIDTH, netLoss, payoutPerContract } from "./program";

export const FALL_MAX = 0.08;
export const STEP = 0.0025;
export const BIG_STEP = 0.01;
export const DETENTS = [BAND_LOWER, BAND_LOWER + BAND_WIDTH] as const; // 1% and 5%
/** A drag that lands this close to a detent sticks to it. */
export const DETENT_PULL = 0.0015;
/** Sample premium per contract, used only until a real quote arrives. Gives "$73.91" for the sample position. */
export const SAMPLE_PREMIUM = 0.11955;

export const PARTIAL_COVER_LABEL = "Partial cover: loss still rises inside the band, just slower.";

const clampFall = (f: number) => Math.min(FALL_MAX, Math.max(0, f));
const tidy = (f: number) => Math.round(f * 1e6) / 1e6;

export type LinePoint = { fall: number; loss: number };

/**
 * The exact net-loss line from 0% to 8%. It is piecewise linear with kinks only at 1% and 5%,
 * so these four points draw it exactly.
 */
export function lossLine(holding: number, contracts: number, premiumTotal: number): LinePoint[] {
  return [0, ...DETENTS, FALL_MAX].map((fall) => ({ fall, loss: netLoss(holding, fall, contracts, premiumTotal) }));
}

/** The uncovered line: the holding's loss with no cover and no premium. */
export function uncoveredLine(holding: number): LinePoint[] {
  return [0, FALL_MAX].map((fall) => ({ fall, loss: holding * fall }));
}

/** Net loss, payout and premium at one fall. */
export function readout(holding: number, fall: number, contracts: number, premiumPerContract: number) {
  const premium = contracts * premiumPerContract;
  return {
    fall,
    holdingLoss: holding * fall,
    payout: contracts * payoutPerContract(fall),
    premium,
    netLoss: netLoss(holding, fall, contracts, premium),
  };
}

/** Change in net loss per 1% of fall inside the band. Zero at the suggested cover. */
export function bandSlope(holding: number, contracts: number): number {
  return holding * 0.01 - contracts * (0.01 / BAND_WIDTH);
}

/**
 * Keyboard stepping. Arrows move 0.25% on a fixed grid. Page keys move 1% but stop at the 1% and 5% detents.
 * Home and End go to 0% and 8%.
 */
export function stepFall(current: number, key: string): number {
  const c = clampFall(current);
  const grid = (f: number, dir: 1 | -1) => {
    const n = c / STEP;
    const base = dir > 0 ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
    return tidy(clampFall((base + dir) * STEP));
  };
  switch (key) {
    case "ArrowRight": case "ArrowUp": return grid(c, 1);
    case "ArrowLeft": case "ArrowDown": return grid(c, -1);
    case "PageUp": {
      const to = clampFall(c + BIG_STEP);
      const d = DETENTS.find((x) => x > c + 1e-9 && x < to - 1e-9);
      return tidy(d ?? to);
    }
    case "PageDown": {
      const to = clampFall(c - BIG_STEP);
      const d = [...DETENTS].reverse().find((x) => x < c - 1e-9 && x > to + 1e-9);
      return tidy(d ?? to);
    }
    case "Home": return 0;
    case "End": return FALL_MAX;
    default: return c;
  }
}

/** Dragging: clamp, stick to a detent when close, otherwise keep 0.01% resolution. */
export function snapFall(raw: number): number {
  const f = clampFall(raw);
  const d = DETENTS.find((x) => Math.abs(x - f) <= DETENT_PULL);
  return d ?? Math.round(f * 10_000) / 10_000;
}

export const fmtPct = (f: number) => `${(f * 100).toFixed(2)}%`;
