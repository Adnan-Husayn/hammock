// The cover card's facts and words. Pure, so the card, the ledger, the receipt export and the tests share them.
import { fmtUsd, payoutPerContract } from "./program";
import { readout, signedUsd } from "./line";

export type CoverStatus = "Cover active" | "Monday mark final" | "Expired, no payout" | "Claimed" | "Voided";
export const STATUSES: readonly CoverStatus[] = ["Cover active", "Monday mark final", "Expired, no payout", "Claimed", "Voided"];

export type CoverKind = "demo" | "real";

/** One position record. Demo covers live in this browser; real covers are read from chain. */
export type CoverRecord = {
  id: string;
  kind: CoverKind;
  symbol: string;
  /** USD the cover was sized for at purchase. */
  holding: number;
  contracts: number;
  /** Total premium paid, USD. */
  premium: number;
  fridayPrice: number | null;
  fridayAt: number | null;
  mondayAt: number | null;
  mondayPrice: number | null;
  status: CoverStatus;
  /** Payout per contract as settled. When absent it follows from the marks. */
  payoutPerContract?: number;
  /** Signed Pyth marks matched against the archive. Only then is the marker blue. */
  verified?: boolean;
  /** Voided and the premium already returned. */
  refunded?: boolean;
};

/** Demo weekend: $5,000 of the token, 200 contracts, a 3% fall from $180.00 to $174.60. Made-up prices. */
export const DEMO_HOLDING = 5000;
export const DEMO_FRIDAY = 180;
export const DEMO_MONDAY = 174.6;
export const DEMO_PREMIUM_PER_CONTRACT = 0.11955;
export const DEMO_LABEL = "Demo prices, not Pyth, not a settlement";
/** How long a demo weekend takes from Cover active to the Monday mark. */
export const DEMO_WEEKEND_MS = 4000;
export const DEMO_TIME_LABEL = `Demo: the 65h 30m weekend runs in about ${Math.round(DEMO_WEEKEND_MS / 1000)} seconds`;
export const SIZED_NOTE = (contracts: number) => `Cover stays at ${contracts} contracts even if your token balance changes.`;
export const WEEKEND_NOTE = (token: string) => `Weekend ${token}, estimate. Does not decide the payout.`;
export const OUTCOME_FALLS = [0, 0.03, 0.08] as const;

export const measured = (friday: number | null, monday: number | null) =>
  friday && monday !== null ? (friday - monday) / friday : null;

/** The fall used for the numbers: measured once Monday is in, otherwise the preview fall. */
export function coverFall(c: Pick<CoverRecord, "fridayPrice" | "mondayPrice">, preview: number) {
  const m = measured(c.fridayPrice, c.mondayPrice);
  return m === null ? preview : Math.max(0, m);
}

export function coverNumbers(c: Pick<CoverRecord, "holding" | "contracts" | "premium" | "payoutPerContract">, fall: number) {
  const r = readout(c.holding, fall, c.contracts, c.contracts ? c.premium / c.contracts : 0);
  if (c.payoutPerContract === undefined) return r;
  const payout = c.contracts * c.payoutPerContract;
  return { ...r, payout, netLoss: r.holdingLoss - payout + r.premium };
}

export const payoutFor = (c: Pick<CoverRecord, "contracts" | "payoutPerContract" | "fridayPrice" | "mondayPrice">) => {
  const m = measured(c.fridayPrice, c.mondayPrice);
  return c.contracts * (c.payoutPerContract ?? (m === null ? 0 : payoutPerContract(m)));
};

/** "stock -$150.00 + payout +$100.00 - premium $23.91 = net -$73.91" */
export function sumLine(r: { holdingLoss: number; payout: number; premium: number; netLoss: number }) {
  const pay = r.payout >= 0.005 ? `+${fmtUsd(r.payout)}` : "$0.00";
  return `stock ${signedUsd(-r.holdingLoss)} + payout ${pay} - premium ${fmtUsd(r.premium)} = net ${signedUsd(-r.netLoss)}`;
}

/** The status a settled demo reaches before any claim. */
/** The status as shown. A demo never claims a Monday mark: it reads "Demo mark final". */
export const statusLabel = (c: Pick<CoverRecord, "kind" | "status">) => (c.kind === "demo" && c.status === "Monday mark final" ? "Demo mark final" : c.status);

/** One line above the claim button saying where the result comes from. */
export const sourceLine = (c: Pick<CoverRecord, "kind" | "verified">) =>
  c.kind === "demo" ? "Demo result, no signed price proof" : c.verified ? "Verified Pyth result, receipt available" : "Result read from chain, signed proof not matched yet";

export const settledStatus = (payout: number): CoverStatus => (payout >= 0.005 ? "Monday mark final" : "Expired, no payout");

/** One line answering "What happens now?". */
export function whatNow(c: CoverRecord, extra: { buyBy?: string } = {}): string {
  const demo = c.kind === "demo";
  const payout = payoutFor(c);
  switch (c.status) {
    case "Cover active":
      return demo
        ? "The Monday 09:30 ET mark decides the payout. It lands in a few seconds."
        : `${extra.buyBy ? `Buying ends ${extra.buyBy}. ` : ""}The Monday 09:30 ET mark decides the payout.`;
    case "Monday mark final":
      return demo ? `Monday mark is in. Claim the ${fmtUsd(payout)} demo payout. Demo USDC only, no real funds.` : `Claim ${fmtUsd(payout)} USDC to your wallet.`;
    case "Expired, no payout":
      return "The fall was 1% or less, so nothing is due. The premium is spent.";
    case "Claimed":
      return demo ? `Done. Demo payout of ${fmtUsd(payout)} recorded, no tokens moved.` : `Done. ${fmtUsd(payout)} USDC sent to your wallet.`;
    case "Voided":
      return c.refunded ? `Refunded. ${fmtUsd(c.premium)} USDC premium returned to your wallet.` : "No Monday mark met the rules. Take a refund of the premium below.";
  }
}

/* ---------- New York time ---------- */

const TZ = "America/New_York";

function etParts(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, min: +p.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** UTC ms for a New York wall-clock time. */
export function etToUtc(y: number, m: number, d: number, h: number, min: number) {
  const guess = Date.UTC(y, m, d, h, min);
  const w = etParts(guess);
  const off = Date.UTC(w.y, w.m, w.d, w.h, w.min) - guess;
  return guess - off;
}

/** "Fri 6 Nov, 16:00 ET" */
export function fmtEtDay(ms: number) {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const g = (t: string) => s.find((x) => x.type === t)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")}, ${g("hour")}:${g("minute")} ET`;
}

/** Friday 16:00 ET, Monday 09:30 ET and the Sunday 17:50 ET buy-by for the Friday on a given calendar date. */
function weekendOf(y: number, m: number, d: number) {
  return {
    friday: etToUtc(y, m, d, 16, 0),
    monday: etToUtc(y, m, d + 3, 9, 30),
    // Buying closes on Sunday evening in the configured markets; a real market's own close replaces this.
    buyBy: etToUtc(y, m, d + 2, 17, 50),
  };
}

function fridayDates(nowMs: number) {
  const n = etParts(nowMs);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(n.y, n.m, n.d + i));
    if (day.getUTCDay() !== 5) continue;
    const w = weekendOf(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    if (w.friday > nowMs) return day;
  }
  throw new Error("unreachable");
}

/** The next Friday 16:00 ET mark strictly after now, the Monday 09:30 ET mark after it, and the buy-by time. */
export function nextWeekend(nowMs: number) {
  const day = fridayDates(nowMs);
  return weekendOf(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/** A demo run plays the upcoming weekend in compressed time, so its dates match the preview. */
export function demoWeekend(nowMs: number) {
  const w = nextWeekend(nowMs);
  return { friday: w.friday, monday: w.monday };
}

/* ---------- Receipt export ---------- */

export function receiptText(c: CoverRecord, product: string): string {
  const fall = measured(c.fridayPrice, c.mondayPrice);
  const r = coverNumbers(c, fall === null ? 0 : Math.max(0, fall));
  const token = `${c.symbol}x`;
  const lines = [
    `${product}: cover receipt`,
    c.kind === "demo" ? `DEMO. ${DEMO_LABEL}.` : "Solana devnet.",
    "",
    `Status: ${c.status}`,
    `Stock: ${token}, sized for ${fmtUsd(c.holding)}`,
    `Contracts: ${c.contracts}`,
    `Premium: ${fmtUsd(c.premium)}`,
    `Payout cap: ${fmtUsd(c.contracts)}`,
    `Friday mark: ${c.fridayPrice === null ? "none" : fmtUsd(c.fridayPrice)}${c.fridayAt ? ` (${fmtEtDay(c.fridayAt)})` : ""}`,
    `Monday mark: ${c.mondayPrice === null ? "none" : fmtUsd(c.mondayPrice)}${c.mondayAt ? ` (${fmtEtDay(c.mondayAt)})` : ""}`,
  ];
  if (c.status === "Voided") lines.push("Result: void, premium refunded", "Net loss: no Monday mark, so no cover result");
  else if (fall !== null) {
    lines.push(
      `Measured fall: ${(fall * 100).toFixed(2)}%`,
      `Payout: ${fmtUsd(r.payout)}`,
      `Net loss: ${signedUsd(-r.netLoss)} (without cover ${signedUsd(-r.holdingLoss)})`,
      sumLine(r),
    );
  }
  return lines.join("\n") + "\n";
}
