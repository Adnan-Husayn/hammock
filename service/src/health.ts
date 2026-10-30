export const SILENCE_MS = 60_000;
export const NEAR_MARK_MS = 10 * 60_000;

const label = (url: string) => {
  try {
    return new URL(url).host; // host only: never a query string
  } catch {
    return "unknown";
  }
};

/** Last frame per stream endpoint, and the check that raises a silent one around a mark. */
export class StreamHealth {
  private last = new Map<string, number | null>();
  private silent = new Set<string>();
  private startedMs: number;

  constructor(endpoints: readonly string[], startedMs: number) {
    this.startedMs = startedMs;
    for (const e of endpoints) this.last.set(label(e), null);
  }

  frame(url: string, nowMs: number) {
    const e = label(url);
    this.last.set(e, nowMs);
    this.silent.delete(e);
  }

  report(nowMs: number) {
    return [...this.last].map(([endpoint, t]) => ({ endpoint, lastFrameAgeS: t === null ? null : Math.floor((nowMs - t) / 1000) }));
  }

  anyFrameWithin(nowMs: number, ms: number) {
    return [...this.last.values()].some((t) => t !== null && nowMs - t <= ms);
  }

  /** Lines to log: each endpoint once per silence, when it passes 60 s within 10 minutes of a mark. */
  check(nowMs: number, targetsUs: readonly bigint[]): string[] {
    const nowUs = BigInt(nowMs) * 1000n;
    const limit = BigInt(NEAR_MARK_MS) * 1000n;
    if (!targetsUs.some((t) => (nowUs >= t ? nowUs - t : t - nowUs) <= limit)) return [];
    const out: string[] = [];
    for (const [e, t] of this.last) {
      const quiet = nowMs - (t ?? this.startedMs);
      if (quiet <= SILENCE_MS || this.silent.has(e)) continue;
      this.silent.add(e);
      out.push(`stream ${e} silent for ${Math.floor(quiet / 1000)} s within 10 minutes of a mark`);
    }
    return out;
  }
}

/** An error's message with URLs removed, since an RPC URL can carry an API key. */
export function safeError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\b(?:https?|wss?):\/\/\S+/g, "[url]");
}
