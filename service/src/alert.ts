import { safeError } from "./health.ts";

export const ALERT_REPEAT_MS = 10 * 60_000;
export const ALERT_PER_HOUR = 20;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * Optional webhook alerts (ALERT_WEBHOOK_URL). Each message is a short JSON body with no keys or tokens; text has URLs
 * stripped. The same key alerts at most once per 10 minutes, and at most 20 alerts go out per hour in all.
 * A failing webhook is logged and ignored, so alerting can never stop the keeper.
 */
export class Alerter {
  private lastByKey = new Map<string, number>();
  private sent: number[] = [];
  private url: string | undefined;
  private fetchFn: FetchLike;
  private nowMs: () => number;

  constructor(url: string | undefined, fetchFn: FetchLike = fetch as unknown as FetchLike, nowMs: () => number = Date.now) {
    this.url = url?.trim() || undefined;
    this.fetchFn = fetchFn;
    this.nowMs = nowMs;
  }

  /** Returns whether a POST was attempted. */
  alert(key: string, text: string): boolean {
    if (!this.url) return false;
    const now = this.nowMs();
    if (now - (this.lastByKey.get(key) ?? -Infinity) < ALERT_REPEAT_MS) return false;
    this.sent = this.sent.filter((t) => now - t < 3_600_000);
    if (this.sent.length >= ALERT_PER_HOUR) return false;
    this.lastByKey.set(key, now);
    this.sent.push(now);
    const body = JSON.stringify({ text: safeError(text).slice(0, 500), source: "gap-cover-service", atMs: now });
    this.fetchFn(this.url, { method: "POST", headers: { "content-type": "application/json" }, body })
      .then((r) => { if (!r.ok) console.error(`alert webhook answered ${r.status}`); })
      .catch((e) => console.error(`alert webhook failed: ${safeError(e)}`));
    return true;
  }
}
