import { describe, expect, it } from "vitest";
import { Archive, type Leg } from "../src/archive.ts";
import { Keeper, type Chain, type MarketView } from "../src/keeper.ts";
import type { SignedUpdate } from "../src/pyth.ts";
import { PARAMS, TS, upd } from "./helpers.ts";

const F = TS; // Friday target
const M = TS + 1_000_000_000n; // Monday target

class FakeChain implements Chain {
  cand: Record<Leg, bigint | null> = { friday: null, monday: null };
  finalised: Record<Leg, boolean> = { friday: false, monday: false };
  reject = new Set<string>();
  submits: { leg: Leg; ts: bigint }[] = [];
  fins: Leg[] = [];
  async readMarket(): Promise<MarketView> {
    return {
      targetUs: { friday: F, monday: M },
      params: { friday: PARAMS, monday: PARAMS },
      candidateFeedTsUs: { ...this.cand },
      finalised: { ...this.finalised },
    };
  }
  async submitReport(_m: string, leg: Leg, u: SignedUpdate) {
    this.submits.push({ leg, ts: u.feedTsUs });
    if (this.reject.has(u.hash)) return false;
    this.cand[leg] = u.feedTsUs;
    return true;
  }
  async finalise(_m: string, leg: Leg) {
    this.fins.push(leg);
    this.finalised[leg] = true;
  }
}

function setup(now: bigint) {
  const archive = new Archive();
  const chain = new FakeChain();
  let t = now;
  const keeper = new Keeper(archive, chain, () => t);
  return { archive, chain, keeper, at: (x: bigint) => (t = x) };
}

describe("Keeper", () => {
  it("waits until T + 2 s", async () => {
    const s = setup(F + 1_999_999n);
    s.archive.add(upd(F));
    await s.keeper.tick("m");
    expect(s.chain.submits).toEqual([]);
    s.at(F + 2_000_000n);
    await s.keeper.tick("m");
    expect(s.chain.submits).toEqual([{ leg: "friday", ts: F }]);
  });

  it("submits the best eligible update, not the first arrival", async () => {
    const s = setup(F + 2_000_000n);
    s.archive.add(upd(F + 400_000n));
    s.archive.add(upd(F - 100_000n));
    await s.keeper.tick("m");
    expect(s.chain.submits.map((x) => x.ts)).toEqual([F - 100_000n]);
  });

  it("resubmits only a strictly better update", async () => {
    const s = setup(F + 2_000_000n);
    s.archive.add(upd(F + 200_000n));
    await s.keeper.tick("m");
    await s.keeper.tick("m"); // nothing new
    s.archive.add(upd(F + 200_000n)); // same key, different bytes: ties keep the on-chain one
    s.archive.add(upd(F + 300_000n)); // worse
    await s.keeper.tick("m");
    expect(s.chain.submits).toHaveLength(1);
    s.archive.add(upd(F + 100_000n)); // strictly better
    await s.keeper.tick("m");
    expect(s.chain.submits.map((x) => x.ts)).toEqual([F + 200_000n, F + 100_000n]);
  });

  it("respects a better candidate already on chain", async () => {
    const s = setup(F + 2_000_000n);
    s.chain.cand.friday = F + 10n;
    s.archive.add(upd(F + 200_000n));
    await s.keeper.tick("m");
    expect(s.chain.submits).toEqual([]);
  });

  it("marks a rejected update and never resends it", async () => {
    const s = setup(F + 2_000_000n);
    const best = upd(F + 1n);
    const next = upd(F + 300_000n);
    s.archive.add(best);
    s.archive.add(next);
    s.chain.reject.add(best.hash);
    await s.keeper.tick("m");
    expect(s.keeper.isRejected(best.hash)).toBe(true);
    await s.keeper.tick("m");
    await s.keeper.tick("m");
    expect(s.chain.submits.map((x) => x.ts)).toEqual([F + 1n, F + 300_000n]);
  });

  it("finalises the right leg after T + 7 min, and not before", async () => {
    const s = setup(F + 2_000_000n);
    s.archive.add(upd(F));
    await s.keeper.tick("m");
    s.at(F + 419_999_999n);
    await s.keeper.tick("m");
    expect(s.chain.fins).toEqual([]);
    s.at(F + 420_000_000n);
    await s.keeper.tick("m");
    expect(s.chain.fins).toEqual(["friday"]);
    await s.keeper.tick("m");
    expect(s.chain.fins).toEqual(["friday"]);
    s.at(M + 420_000_000n);
    await s.keeper.tick("m");
    expect(s.chain.fins).toEqual(["friday", "monday"]);
  });

  it("does not submit after the window has closed", async () => {
    const s = setup(F + 420_000_000n);
    s.archive.add(upd(F));
    await s.keeper.tick("m");
    expect(s.chain.submits).toEqual([]);
  });
});
