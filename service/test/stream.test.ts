import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStreamMessage, streamNvda, type SocketLike } from "../src/pyth.ts";
import { fixture } from "./helpers.ts";

describe("signed bytes vs parsed JSON", () => {
  it("accepts a consistent update", () => {
    expect(parseStreamMessage(fixture("regular-2026-10-29"))).not.toBeNull();
    expect(parseStreamMessage(fixture("premarket-2026-10-29"))).not.toBeNull();
  });
  it.each([
    ["price", (m: any) => (m.parsed.priceFeeds[0].price = "21430044")],
    ["confidence", (m: any) => (m.parsed.priceFeeds[0].confidence = 1)],
    ["publishers", (m: any) => (m.parsed.priceFeeds[0].publisherCount = 21)],
    ["exponent", (m: any) => (m.parsed.priceFeeds[0].exponent = -6)],
    ["session", (m: any) => (m.parsed.priceFeeds[0].marketSession = "preMarket")],
    ["feed timestamp", (m: any) => (m.parsed.priceFeeds[0].feedUpdateTimestamp += 1)],
    ["timestamp", (m: any) => (m.parsed.timestampUs = "1793280669400001")],
    ["truncated bytes", (m: any) => (m.solana.data = m.solana.data.slice(0, -2))],
  ])("drops an update whose %s disagrees", (_n, mutate) => {
    const m = fixture("regular-2026-10-29");
    mutate(m);
    expect(parseStreamMessage(m)).toBeNull();
  });
});

class FakeSocket implements SocketLike {
  h: Record<string, (...a: any[]) => void> = {};
  terminated = false;
  sent: string[] = [];
  on(ev: string, cb: (...a: any[]) => void) { this.h[ev] = cb; return this; }
  send(d: string) { this.sent.push(d); }
  terminate() { this.terminated = true; this.h.close?.(); }
}

describe("streamNvda watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates a silent socket and reconnects with backoff, while others carry on", () => {
    const socks: FakeSocket[] = [];
    const byUrl: Record<string, FakeSocket[]> = { a: [], b: [] };
    const got: string[] = [];
    const stop = streamNvda((u) => got.push(u.hash), {
      endpoints: ["a", "b"], token: "t", idleMs: 3000, backoffMs: [1000, 4000],
      makeSocket: (url) => { const s = new FakeSocket(); socks.push(s); byUrl[url].push(s); return s; },
    });
    const [a, b] = [byUrl.a, byUrl.b];
    socks.forEach((s) => s.h.open());
    expect(a[0].sent).toHaveLength(1);
    const frame = JSON.stringify(fixture("regular-2026-10-29"));
    // b keeps talking every second; a goes silent.
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(1000); b[0].h.message(frame); }
    vi.advanceTimersByTime(100);
    expect(a[0].terminated).toBe(true);
    expect(b[0].terminated).toBe(false);
    expect(got).toHaveLength(3);
    vi.advanceTimersByTime(900); // first backoff is 1 s
    expect(a).toHaveLength(2);
    // Silent again: the next backoff doubles to 2 s.
    a[1].h.open();
    vi.advanceTimersByTime(3000);
    expect(a[1].terminated).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(a).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(a).toHaveLength(3);
    stop();
    const n = socks.length;
    vi.advanceTimersByTime(60000);
    expect(socks).toHaveLength(n);
  });
});

describe("live capture", () => {
  it("a real postMarket frame decodes and agrees with its JSON", () => {
    const u = parseStreamMessage(fixture("live-smoke-2026-10-30"))!;
    expect(u.session).toBe("postMarket");
    expect(u.price).toBe(21_043_004n);
    expect(u.publishers).toBe(14);
  });
});

describe("frame reporting", () => {
  it("reports each endpoint's frames, including ones that parse to nothing", () => {
    const sockets: FakeSocket[] = [];
    const frames: string[] = [];
    const stop = streamNvda(() => {}, {
      endpoints: ["wss://a/x", "wss://b/x"],
      token: "t",
      makeSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      onFrame: (u) => frames.push(u),
    });
    sockets[1].h.message("{}");
    sockets[0].h.message("not json");
    stop();
    expect(frames).toEqual(["wss://b/x", "wss://a/x"]);
  });
});
