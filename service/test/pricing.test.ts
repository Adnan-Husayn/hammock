import { describe, expect, it } from "vitest";
import { Freeze, loadGaps, premiumPerContract, priceBreakdown } from "../src/pricing.ts";
import { nvdaxReference, NVDAX_MINT, USDC_MINT } from "../src/jupiter.ts";

const MIN = 60_000;

describe("premiumPerContract (spec section 7)", () => {
  it("all gaps 0 and m 0 gives uncertainty floor plus reserve: 0.007", () => {
    expect(premiumPerContract({ gaps: new Array(104).fill(0), m: 0, sold: 0, max: 200 })).toBe(0.007);
  });
  it("gaps [0.02], m 0, sold 0 gives 0.3195", () => {
    expect(premiumPerContract({ gaps: [0.02], m: 0, sold: 0, max: 200 })).toBe(0.3195);
  });
  it("at sold = max the utilisation term adds 2 * base", () => {
    const b = priceBreakdown({ gaps: [0.02], m: 0, sold: 200, max: 200 });
    expect(b.base).toBe(0.25);
    expect(b.utilisation).toBe(0.5);
    expect(premiumPerContract({ gaps: [0.02], m: 0, sold: 200, max: 200 })).toBe(0.8195);
  });
  it("m shifts every gap and p_i clamps to [0, 1]", () => {
    // (0.02 + 0.01 - 0.01) / 0.04 = 0.5 and (-0.5 + 0.01 - 0.01) clamps to 0: base 0.25.
    expect(priceBreakdown({ gaps: [0.02, -0.5], m: 0.01, sold: 0, max: 10 }).base).toBeCloseTo(0.25, 12);
    expect(priceBreakdown({ gaps: [0.5], m: 0, sold: 0, max: 10 }).base).toBe(1);
  });
  it("rounds up to the base unit", () => {
    const p = premiumPerContract({ gaps: [0.011, 0, 0], m: 0, sold: 0, max: 10 })!;
    expect(Number.isInteger(Math.round(p * 1e6))).toBe(true);
    expect(p).toBeGreaterThanOrEqual(priceBreakdown({ gaps: [0.011, 0, 0], m: 0, sold: 0, max: 10 }).raw);
  });
  it("returns null at or above 0.95", () => {
    expect(premiumPerContract({ gaps: [0.05], m: 0, sold: 0, max: 10 })).toBeNull(); // 1 + 0.255 + 0.002
    // base 0.756 gives exactly 0.756 + 0.194 + 0.002 = 0.952
    expect(premiumPerContract({ gaps: [0.04024], m: 0, sold: 0, max: 10 })).toBeNull();
    // base 0.7544 gives exactly 0.7544 + 0.1936 + 0.002 = 0.95
    expect(premiumPerContract({ gaps: [0.040176], m: 0, sold: 0, max: 10 })).toBeNull();
  });
  it("just under 0.95 still quotes", () => {
    expect(premiumPerContract({ gaps: [0.0398], m: 0, sold: 0, max: 10 })).not.toBeNull();
  });
});

describe("Freeze", () => {
  const ref = (price: number, roundTripBps = 20) => ({ price, roundTripBps, multiplier: 1, decimals: 8 });

  it("is frozen before any reference arrives", () => {
    expect(new Freeze().isFrozen(0)).toBe(true);
  });
  it("no route freezes, and quoting resumes only after 15 clean minutes", () => {
    const f = new Freeze();
    f.update(ref(200), 0);
    expect(f.isFrozen(0)).toBe(false);
    f.update(null, 1 * MIN);
    expect(f.isFrozen(1 * MIN)).toBe(true);
    f.update(ref(200), 2 * MIN);
    expect(f.isFrozen(15 * MIN)).toBe(true);
    expect(f.isFrozen(16 * MIN - 1)).toBe(true);
    expect(f.isFrozen(16 * MIN)).toBe(false);
  });
  it("round trip above 100 bps freezes; exactly 100 does not", () => {
    const f = new Freeze();
    f.update(ref(200, 100), 0);
    expect(f.isFrozen(0)).toBe(false);
    f.update(ref(200, 101), MIN);
    expect(f.isFrozen(MIN)).toBe(true);
    expect(f.isFrozen(16 * MIN)).toBe(false);
  });
  it("a move of more than 5% within 30 minutes freezes", () => {
    const f = new Freeze();
    f.update(ref(200), 0);
    f.update(ref(210), 10 * MIN); // exactly 5%
    expect(f.isFrozen(10 * MIN)).toBe(false);
    f.update(ref(189), 20 * MIN); // 10% below 210
    expect(f.isFrozen(20 * MIN)).toBe(true);
  });
  it("a 5% move spread over more than 30 minutes does not freeze", () => {
    const f = new Freeze();
    f.update(ref(200), 0);
    f.update(ref(206), 20 * MIN);
    f.update(ref(212), 40 * MIN); // 6% vs t=0 (outside window), 2.9% vs t=20
    expect(f.isFrozen(40 * MIN)).toBe(false);
  });
  it("the trigger keeps firing while the moved price is in the window, then lifts 15 minutes later", () => {
    const f = new Freeze();
    f.update(ref(200), 0);
    f.update(ref(220), 1 * MIN);
    for (let t = 2; t <= 31; t++) f.update(ref(220), t * MIN); // t=0 price leaves the window after minute 30
    expect(f.isFrozen(31 * MIN)).toBe(true); // last trigger at minute 30
    expect(f.isFrozen(45 * MIN)).toBe(false);
  });
  it("keeps the last good reference for sandbox markets", () => {
    const f = new Freeze();
    f.update(ref(200), 0);
    f.update(null, MIN);
    expect(f.lastGood?.price).toBe(200);
  });
});

describe("loadGaps", () => {
  it("reads the committed 104-weekend CSV", () => {
    const g = loadGaps();
    expect(g.length).toBe(104);
    expect(g.every((x) => Number.isFinite(x) && Math.abs(x) < 0.5)).toBe(true);
  });
});

describe("nvdaxReference (stubbed Jupiter)", () => {
  it("prices from the round trip with the effective multiplier", async () => {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.searchParams.get("inputMint") === USDC_MINT) return { outAmount: "500000000" }; // 5 raw-units-of-1e8 = 5 tokens
      return { outAmount: "995000000" }; // 995 USDC back
    };
    const r = await nvdaxReference({
      fetchJson,
      readMint: async () => ({ decimals: 8, multiplier: 1, newMultiplier: 1.25, newMultiplierEffectiveTs: 100 }),
      nowS: () => 200,
    });
    // shares = 5 * 1.25 = 6.25, price = 160, round trip = 50 bps
    expect(r).toEqual({ price: 160, roundTripBps: 50, multiplier: 1.25, decimals: 8 });
    expect(calls[0]).toContain(`outputMint=${NVDAX_MINT}`);
    expect(calls[0]).toContain("amount=1000000000");
    expect(calls[1]).toContain("amount=500000000");
  });
  it("returns null when Jupiter has no route or fails", async () => {
    const readMint = async () => ({ decimals: 8, multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTs: 0 });
    expect(await nvdaxReference({ fetchJson: async () => ({ error: "No routes found" }), readMint })).toBeNull();
    expect(await nvdaxReference({ fetchJson: async () => { throw new Error("down"); }, readMint })).toBeNull();
  });
});
