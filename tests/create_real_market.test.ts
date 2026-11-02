import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CREATE_LEAD_S, DEFAULT_MAX_CONTRACTS, Refusal, buildRealMarketParams, buyingClose, checkMultiplier, describeParams, reserveUsdc,
} from "../scripts/create-real-market";
import { createMarketInstruction, marketAddress } from "../service/src/sandbox";

const quoteKey = Keypair.generate().publicKey;
const flat = { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTs: 0n };
const s = (iso: string) => BigInt(Date.parse(iso) / 1000);
const iso = (v: bigint) => new Date(Number(v) * 1000).toISOString();
const NOW = s("2026-11-03T15:00:00Z");

describe("create-real-market params", () => {
  it("normal week: Friday 15:59:30 ET, Monday 09:31:30 ET, buying closes Sunday 17:50 ET", () => {
    const p = buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat });
    expect([iso(p.fridayTargetTs), iso(p.mondayTargetTs), iso(p.buyingCloseTs)]).toEqual([
      "2026-11-06T20:59:30.000Z", "2026-11-09T14:31:30.000Z", "2026-11-08T22:50:00.000Z",
    ]);
    expect(p).toMatchObject({ sandbox: false, demoAuthority: PublicKey.default, maxContracts: DEFAULT_MAX_CONTRACTS, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10 });
    expect(reserveUsdc(p)).toBe(5_000_200_000n);
  });

  it("early-close Friday 27 Nov (Thanksgiving week, anchored on the Friday) uses 12:59:30 ET", () => {
    const p = buildRealMarketParams({ dateEt: "2026-11-27", nowS: NOW, quoteKey, multiplier: flat });
    expect([iso(p.fridayTargetTs), iso(p.buyingCloseTs)]).toEqual(["2026-11-27T17:59:30.000Z", "2026-11-29T22:50:00.000Z"]);
  });

  it("refuses a holiday anchor day", () => {
    expect(() => buildRealMarketParams({ dateEt: "2026-11-26", nowS: NOW, quoteKey, multiplier: flat })).toThrow(Refusal);
  });

  it("refuses inside the creation lead time", () => {
    const fri = s("2026-11-06T20:59:30Z");
    expect(() => buildRealMarketParams({ dateEt: "2026-11-06", nowS: fri - BigInt(CREATE_LEAD_S) + 1n, quoteKey, multiplier: flat })).toThrow(/at least an hour/);
    expect(() => buildRealMarketParams({ dateEt: "2026-11-06", nowS: fri - BigInt(CREATE_LEAD_S), quoteKey, multiplier: flat })).not.toThrow();
  });

  it("refuses a multiplier change scheduled between now and the Monday target, and only then", () => {
    const mon = s("2026-11-09T14:31:30Z");
    const change = (t: bigint, to = 1.5) => ({ multiplier: 1, newMultiplier: to, newMultiplierEffectiveTs: t });
    expect(() => buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: change(mon) })).toThrow(/multiplier change/);
    expect(() => checkMultiplier(change(NOW + 1n), NOW, mon)).toThrow(Refusal);
    expect(() => checkMultiplier(change(NOW), NOW, mon)).not.toThrow(); // already in effect
    expect(() => checkMultiplier(change(mon + 1n), NOW, mon)).not.toThrow(); // after the Monday target
    expect(() => checkMultiplier(change(NOW + 10n, 1), NOW, mon)).not.toThrow(); // same value, no change
  });

  it("rejects a bad max contracts", () => {
    expect(() => buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat, maxContracts: 0 })).toThrow(Refusal);
    expect(() => buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat, maxContracts: 1.5 })).toThrow(Refusal);
  });

  it("buying close is Sunday 17:50 ET across the DST change", () => {
    expect(buyingClose(new Date("2026-11-02T14:31:30Z")).toISOString()).toBe("2026-11-01T22:50:00.000Z"); // EST from 1 Nov 02:00
    expect(buyingClose(new Date("2026-10-26T13:31:30Z")).toISOString()).toBe("2026-10-25T21:50:00.000Z"); // EDT
  });

  it("takes the symbol's feed id and caps, and a different address per stock on the same weekend", () => {
    const nvda = buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat });
    const tsla = buildRealMarketParams({ symbol: "TSLA", dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat });
    expect(nvda.feedId).toBe(1314);
    expect(tsla).toMatchObject({ feedId: 1435, fridayConfCapBps: 16, mondayConfCapBps: 67, fridayTargetTs: nvda.fridayTargetTs });
    const programId = Keypair.generate().publicKey, dealer = Keypair.generate().publicKey;
    expect(marketAddress(programId, dealer, 1314, nvda.fridayTargetTs).equals(marketAddress(programId, dealer, 1435, tsla.fridayTargetTs))).toBe(false);
    expect(() => buildRealMarketParams({ symbol: "XYZ", dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat })).toThrow(Refusal);
  });

  it("encodes to the IDL's MarketParams and the IDL's create_market accounts", () => {
    const idl = JSON.parse(readFileSync(new URL("../idl/gap_cover.json", import.meta.url), "utf8"));
    const p = buildRealMarketParams({ dateEt: "2026-11-06", nowS: NOW, quoteKey, multiplier: flat });
    const programId = Keypair.generate().publicKey, dealer = Keypair.generate().publicKey;
    const { market, ix } = createMarketInstruction(programId, dealer, Keypair.generate().publicKey, Keypair.generate().publicKey, p);
    const d: any = new BorshCoder(idl).instruction.decode(Buffer.from(ix.data))!;
    expect(d.name).toBe("create_market");
    const q = d.data.params;
    expect([q.friday_target_ts.toString(), q.monday_target_ts.toString(), q.buying_close_ts.toString()]).toEqual([p.fridayTargetTs, p.mondayTargetTs, p.buyingCloseTs].map(String));
    expect(q.feed_id).toBe(1314);
    expect(q.exponent).toBe(-5);
    expect(q.sandbox).toBe(false);
    expect(q.demo_authority.equals(PublicKey.default)).toBe(true);
    expect(q.max_contracts).toBe(DEFAULT_MAX_CONTRACTS);
    expect(q.bounty_per_leg.toString()).toBe("100000");
    const def = idl.instructions.find((i: any) => i.name === "create_market");
    expect(ix.keys).toHaveLength(def.accounts.length);
    expect(ix.keys[1].pubkey.equals(market)).toBe(true);
    expect(describeParams(p, market)).toMatchObject({ market: market.toBase58(), reserveUsdc: "5000.20", sandbox: false });
  });
});
