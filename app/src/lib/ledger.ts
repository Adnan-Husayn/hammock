// Demo covers kept in this browser. Real covers are read from chain; this store never decides a real figure.
import { payoutFor, type CoverKind, type CoverRecord } from "./cover";

export const LEDGER_KEY = "cover-ledger-v1";

export function loadLedger(): CoverRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(LEDGER_KEY);
    const v = raw ? JSON.parse(raw) : [];
    // An unfinished demo is not a position: only Claimed and Expired demo runs survive a reload.
    return Array.isArray(v) ? v.filter((c) => c && c.kind === "demo" && (c.status === "Claimed" || c.status === "Expired, no payout")) : [];
  } catch {
    return [];
  }
}

export function saveLedger(list: CoverRecord[]) {
  try {
    globalThis.localStorage?.setItem(LEDGER_KEY, JSON.stringify(list.filter((c) => c.kind === "demo")));
  } catch {
    // private mode or blocked storage: the ledger lasts for this visit only
  }
}

export const upsert = (list: CoverRecord[], c: CoverRecord) => [c, ...list.filter((x) => x.id !== c.id)];

export const isActive = (c: CoverRecord) => c.status === "Cover active" || c.status === "Monday mark final";

/** Premiums paid, payouts claimed and net, for one kind. A refunded void counts no premium. */
export function totals(list: CoverRecord[], kind: CoverKind) {
  let premiums = 0, payouts = 0;
  for (const c of list.filter((x) => x.kind === kind)) {
    if (c.status !== "Voided") premiums += c.premium;
    if (c.status === "Claimed") payouts += payoutFor(c);
  }
  return { premiums, payouts, net: payouts - premiums, count: list.filter((x) => x.kind === kind).length };
}
