import { describe, expect, it } from "vitest";
import { Archive, archiveServer } from "../src/archive.ts";
import { parseStreamMessage } from "../src/pyth.ts";
import { PARAMS, TS, fixture, premarket, regular, upd } from "./helpers.ts";

describe("parseStreamMessage", () => {
  it("reads the regular fixture and hashes the solana bytes", () => {
    const u = regular();
    expect(u.price).toBe(21_430_043n);
    expect(u.exponent).toBe(-5);
    expect(u.confidence).toBe(21_057n);
    expect(u.publishers).toBe(20);
    expect(u.session).toBe("regular");
    expect(u.feedTsUs).toBe(TS);
    expect(u.timestampUs).toBe(TS);
    expect(u.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores non-update frames", () => {
    expect(parseStreamMessage({ type: "subscribed" })).toBeNull();
  });
  it("reads the premarket fixture session", () => {
    expect(premarket().session).toBe("preMarket");
  });
});

describe("Archive", () => {
  it("stores duplicates once", () => {
    const a = new Archive();
    expect(a.add(regular())).toBe(true);
    expect(a.add(regular())).toBe(false);
    expect(a.size).toBe(1);
  });

  it("accepts the regular fixture and rejects the premarket one", () => {
    const a = new Archive();
    a.add(regular());
    a.add(premarket());
    expect(a.eligible(TS, PARAMS).map((u) => u.hash)).toEqual([regular().hash]);
  });

  it("yields the right best regardless of arrival order", () => {
    const T = TS;
    const mk = () => [upd(T + 300_000n), upd(T - 100_000n), upd(T + 100_000n), upd(T - 400_000n)];
    const a = new Archive();
    for (const u of mk().reverse()) a.add(u);
    const b = new Archive();
    for (const u of mk()) b.add(u);
    const ra = a.eligible(T, PARAMS).map((u) => u.feedTsUs);
    expect(ra).toEqual([T - 100_000n, T + 100_000n, T + 300_000n, T - 400_000n]);
    expect(b.eligible(T, PARAMS).map((u) => u.feedTsUs)).toEqual(ra);
  });

  it("breaks an equal-distance tie by the earlier feed timestamp", () => {
    const a = new Archive();
    a.add(upd(TS + 200_000n));
    a.add(upd(TS - 200_000n));
    expect(a.eligible(TS, PARAMS)[0].feedTsUs).toBe(TS - 200_000n);
  });

  it("excludes each failing bullet", () => {
    const bad = [
      upd(TS, { session: "preMarket" }),
      upd(TS, { timestampUs: TS + 200_000n }), // carried forward
      upd(TS + 5_000_001n),
      upd(TS - 5_000_001n),
      upd(TS, { price: 0n }),
      upd(TS, { price: -5n }),
      upd(TS, { exponent: -6 }),
      upd(TS, { confidence: 21_431n }), // 21_431 * 10_000 > 21_430_043 * 10
      upd(TS, { publishers: 9 }),
    ];
    const a = new Archive();
    for (const u of bad) a.add(u);
    expect(a.eligible(TS, PARAMS)).toEqual([]);
  });

  it("includes both exact edges and the exact confidence boundary", () => {
    const a = new Archive();
    a.add(upd(TS + 5_000_000n));
    a.add(upd(TS - 5_000_000n));
    a.add(upd(TS, { price: 21_430_000n, confidence: 21_430n }));
    a.add(upd(TS + 1n, { publishers: 10 }));
    expect(a.eligible(TS, PARAMS)).toHaveLength(4);
  });

  it("applies the confidence cap per leg", () => {
    const a = new Archive();
    a.add(regular()); // 9.83 bps
    expect(a.eligible(TS, { ...PARAMS, confCapBps: 9 })).toEqual([]);
    expect(a.eligible(TS, { ...PARAMS, confCapBps: 20 })).toHaveLength(1);
  });
});

describe("GET /archive/:market/:leg", () => {
  it("serves the eligible list as JSON and 404s elsewhere", async () => {
    const a = new Archive();
    a.add(regular());
    a.add(premarket());
    const srv = archiveServer(a, (m, leg) => (m === "m1" && leg === "friday" ? { targetUs: TS, params: PARAMS } : undefined));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/archive/m1/friday`);
      expect(ok.status).toBe(200);
      const body: any = await ok.json();
      expect(body.updates).toHaveLength(1);
      expect(body.updates[0].messageHex).toBe(fixture("regular-2026-10-29").solana.data);
      expect(body.updates[0].price).toBe("21430043");
      expect((await fetch(`http://127.0.0.1:${port}/archive/m1/monday`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      srv.close();
    }
  });
});
