import { describe, expect, it } from "vitest";
import { BorshCoder } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { Archive, type Leg } from "../src/archive.ts";
import { MARKETS, enabledMarkets, marketBySymbol, marketByFeed, devnetTestMint } from "../src/config.ts";
import { Keeper, type Chain, type MarketView } from "../src/keeper.ts";
import { parseStreamUpdates, streamFeeds, type SignedUpdate, type SocketLike } from "../src/pyth.ts";
import { gapsPath, loadGaps } from "../src/pricing.ts";
import { Sandbox, encodeSandboxParams, faucet, marketAddress, type DevnetSetup, type SandboxChain } from "../src/sandbox.ts";
import { serviceServer } from "../src/server.ts";
import { PARAMS, TS, fixture, upd } from "./helpers.ts";

const TSLA = { ...PARAMS, feedId: 1435 };
const pk = () => Keypair.generate().publicKey;

describe("markets config", () => {
  it("enables NVDA, TSLA, SPY and AAPL by default, each with a feed, a mainnet mint and a gaps file on disk", () => {
    const on = enabledMarkets({});
    expect(on.map((m) => m.symbol)).toEqual(["NVDA", "TSLA", "SPY", "AAPL"]);
    for (const m of on) {
      expect(m.feedId).toBeGreaterThan(0);
      new PublicKey(m.mainnetMint);
      expect(loadGaps(gapsPath(m.gapsFile))).toHaveLength(104);
      expect(m.confCapBps.friday).toBeGreaterThan(0);
      expect(m.confCapBps.monday).toBeLessThanOrEqual(100); // program bound MAX_CONF_CAP_BPS
    }
    expect(new Set(MARKETS.map((m) => m.feedId)).size).toBe(MARKETS.length);
  });

  it("ENABLED_SYMBOLS overrides the flags and rejects unknown symbols", () => {
    expect(enabledMarkets({ ENABLED_SYMBOLS: "tsla, NVDA" }).map((m) => m.symbol)).toEqual(["TSLA", "NVDA"]);
    expect(() => enabledMarkets({ ENABLED_SYMBOLS: "NVDA,XYZ" })).toThrow(/XYZ/);
  });

  it("looks up by symbol and feed, and finds test mints with the NVDA fallback", () => {
    expect(marketBySymbol("tsla")!.feedId).toBe(1435);
    expect(marketByFeed(922)!.symbol).toBe("AAPL");
    expect(devnetTestMint({ nvdaxTest: { mint: "A" } }, "NVDA")).toBe("A");
    expect(devnetTestMint({ nvdaxTest: { mint: "A" } }, "TSLA")).toBeUndefined();
    expect(devnetTestMint({ testMints: { TSLA: { mint: "B" } } }, "TSLA")).toBe("B");
  });
});

describe("archive keyed by feed", () => {
  it("keeps the same signed message once per feed and serves each market only its own feed", () => {
    const a = new Archive();
    const n = upd(TS, { hash: "same" });
    const t = { ...n, feedId: 1435 };
    expect(a.add(n)).toBe(true);
    expect(a.add(t)).toBe(true);
    expect(a.add({ ...n })).toBe(false);
    expect(a.eligible(TS, PARAMS)).toEqual([n]);
    expect(a.eligible(TS, TSLA)).toEqual([t]);
    expect(a.prune([TS], 5_000_000n, 1435)).toBe(1);
    expect(a.size).toBe(1);
  });
});

class TwoMarkets implements Chain {
  submits: { market: string; hash: string }[] = [];
  rejectOn = new Set<string>();
  async readMarket(market: string): Promise<MarketView> {
    const p = market === "tsla" ? TSLA : PARAMS;
    return {
      targetUs: { friday: TS, monday: TS + 1_000_000_000n },
      params: { friday: p, monday: p },
      candidateFeedTsUs: { friday: null, monday: null },
      finalised: { friday: false, monday: false },
    };
  }
  async submitReport(market: string, _leg: Leg, u: SignedUpdate) {
    this.submits.push({ market, hash: u.hash });
    return !this.rejectOn.has(market);
  }
  async finalise() {}
}

describe("keeper with two markets on one weekend", () => {
  it("submits each market its own feed, and a rejection on one market does not block the other", async () => {
    const archive = new Archive();
    archive.add(upd(TS + 100_000n, { hash: "m1" }));
    archive.add({ ...upd(TS + 100_000n, { hash: "m1" }), feedId: 1435 });
    const chain = new TwoMarkets();
    chain.rejectOn.add("nvda");
    const k = new Keeper(archive, chain, () => TS + 3_000_000n, { prune: false });
    await k.tick("nvda");
    await k.tick("tsla");
    expect(chain.submits).toEqual([{ market: "nvda", hash: "m1" }, { market: "tsla", hash: "m1" }]);
    expect(k.isRejected("m1", "nvda")).toBe(true);
    expect(k.isRejected("m1", "tsla")).toBe(false);
  });
});

class FakeSocket implements SocketLike {
  h: Record<string, (...a: any[]) => void> = {};
  sent: string[] = [];
  on(ev: string, cb: (...a: any[]) => void) { this.h[ev] = cb; return this; }
  send(d: string) { this.sent.push(d); }
  terminate() {}
}

describe("one subscription for every feed", () => {
  it("subscribes once per feed and reads each frame as its subscription's feed", () => {
    const socks: FakeSocket[] = [];
    const got: SignedUpdate[] = [];
    const stop = streamFeeds([1314, 1435, 1398, 922], (u) => got.push(u), {
      endpoints: ["a"], token: "t", makeSocket: () => { const s = new FakeSocket(); socks.push(s); return s; },
    });
    socks[0].h.open();
    const subs = socks[0].sent.map((s) => JSON.parse(s));
    expect(subs.map((s) => [s.subscriptionId, s.priceFeedIds])).toEqual([[1, [1314]], [2, [1435]], [3, [1398]], [4, [922]]]);
    const nvdaFrame = fixture("regular-2026-10-29"); // subscriptionId 1, carries NVDA only
    socks[0].h.message(JSON.stringify(nvdaFrame));
    expect(got.map((u) => u.feedId)).toEqual([1314]);
    // The same bytes arriving on the TSLA subscription carry no TSLA feed and are dropped.
    socks[0].h.message(JSON.stringify({ ...nvdaFrame, subscriptionId: 2 }));
    expect(got).toHaveLength(1);
    // Each emitted update is a single-feed message.
    expect(Buffer.from(got[0].messageHex, "hex")[4 + 64 + 32 + 2 + 4 + 8 + 1]).toBe(1);
    stop();
    expect(parseStreamUpdates(fixture("regular-2026-10-29"), [1435])).toEqual([]);
  });
});

describe("sandbox and faucet per stock", () => {
  it("sandbox start passes the symbol and prices off that symbol's reference", async () => {
    const calls: string[] = [];
    const chain = { createSandboxMarket: async (_m: string, price: bigint, symbol: string) => (calls.push(`${symbol} ${price}`), pk()) } as unknown as SandboxChain;
    const sb = new Sandbox(chain, {
      reference: (s) => ({ price: s === "TSLA" ? 400 : 200, roundTripBps: 1, multiplier: 1, decimals: 8 }),
      recordFridayRef: () => {},
    });
    expect((await sb.start("gap")).symbol).toBe("NVDA");
    expect((await sb.start("gap", "TSLA")).symbol).toBe("TSLA");
    expect(calls).toEqual(["NVDA 20000000", "TSLA 40000000"]);
  });

  it("sandbox params carry the stock's feed and caps; addresses differ per feed", () => {
    const idl = JSON.parse(readFileSync(new URL("../../idl/gap_cover.json", import.meta.url), "utf8"));
    const def = idl.types.find((t: any) => t.name === "MarketParams");
    const q: any = new BorshCoder(idl).types.decode("MarketParams", encodeSandboxParams(1000n, "gap", pk(), pk(), marketBySymbol("TSLA")));
    expect(def.type.fields[0].name).toBe("feed_id");
    expect([q.feed_id, q.exponent, q.friday_conf_cap_bps, q.monday_conf_cap_bps]).toEqual([1435, -5, 16, 67]);
    const program = pk(), dealer = pk();
    expect(marketAddress(program, dealer, 1314, 1000n).equals(marketAddress(program, dealer, 1435, 1000n))).toBe(false);
  });

  it("faucet sends the chosen stock's test token", async () => {
    const sent: Transaction[] = [];
    const conn = {
      getBalance: async () => 1e9,
      getLatestBlockhash: async () => ({ blockhash: pk().toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: async (raw: Buffer) => (sent.push(Transaction.from(raw)), "sig"),
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any;
    const tsla = pk(), nvda = pk();
    const s: DevnetSetup = { conn, programId: pk(), dealer: Keypair.generate(), demo: Keypair.generate(), quoteKey: pk(), usdcMint: pk(), stockMint: nvda, testMints: { TSLA: tsla } };
    await faucet(s, pk(), { symbol: "TSLA" });
    await faucet(s, pk());
    const mintTo = (tx: Transaction) => tx.instructions.at(-1)!.keys[0].pubkey;
    expect(mintTo(sent[0]).equals(tsla)).toBe(true);
    expect(mintTo(sent[1]).equals(nvda)).toBe(true);
    await expect(faucet(s, pk(), { symbol: "SPY" })).rejects.toThrow(/no test mint for SPY/);
  });

  it("HTTP: /markets lists the symbols, sandbox and faucet take a symbol and refuse others", async () => {
    const started: string[] = [];
    const dripped: string[] = [];
    const srv = serviceServer({
      quoter: {} as any,
      sandbox: { start: async (mode: any, symbol: any) => (started.push(symbol), { market: pk(), fridayPrice: 1n, mode, symbol }), bell: async () => { throw 0; } } as any,
      relayPayer: PublicKey.default, relay: async () => { throw 0; },
      faucet: async (_w, symbol) => (dripped.push(symbol), "sig"), relayBalance: async () => 0,
      symbols: ["NVDA", "TSLA"],
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const u = `http://127.0.0.1:${(srv.address() as any).port}`;
    const post = (path: string, b: unknown) => fetch(`${u}${path}`, { method: "POST", body: JSON.stringify(b) });
    try {
      expect(await (await fetch(`${u}/markets`)).json()).toEqual({ symbols: ["NVDA", "TSLA"] });
      expect((await (await post("/sandbox/start", { mode: "gap" })).json()).symbol).toBe("NVDA");
      expect((await (await post("/sandbox/start", { mode: "gap", symbol: "tsla" })).json()).symbol).toBe("TSLA");
      expect((await post("/sandbox/start", { mode: "gap", symbol: "SPY" })).status).toBe(400);
      expect((await post("/faucet", { wallet: pk().toBase58(), symbol: "TSLA" })).status).toBe(200);
      expect((await post("/faucet", { wallet: pk().toBase58(), symbol: "AAPL" })).status).toBe(400);
      expect(started).toEqual(["NVDA", "TSLA"]);
      expect(dripped).toEqual(["TSLA"]);
    } finally {
      srv.close();
    }
  });
});

describe("submit_report transaction size", () => {
  it("a real Ed25519 + submit_report transaction with the fixture message fits in 1232 bytes", async () => {
    const { submitReportInstructions } = await import("../src/chain.ts");
    const msg = Buffer.from(fixture("regular-2026-10-29").solana.data, "hex");
    expect(msg.length).toBe(158);
    expect(msg[4 + 64 + 32 + 2 + 4 + 8 + 1]).toBe(1); // exactly one feed in the signed message
    const payer = Keypair.generate();
    const tx = new Transaction().add(...submitReportInstructions(pk(), payer.publicKey, pk(), "friday", msg));
    tx.recentBlockhash = pk().toBase58();
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const size = tx.serialize().length;
    expect(size).toBeLessThan(700); // 591 bytes with one feed per message; the hard limit is 1232
  });
});

/** A Solana-format envelope over a crafted payload (signature not valid; the decoder does not verify it). */
function envelope(feeds: { id: number; props: [number, Buffer][] }[]): Buffer {
  const u8 = (n: number) => Buffer.from([n]);
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const payload = Buffer.concat([
    u32(0x93c7d375), u64(TS), u8(1), u8(feeds.length),
    ...feeds.flatMap((f) => [u32(f.id), u8(f.props.length), ...f.props.flatMap(([k, v]) => [u8(k), v])]),
  ]);
  return Buffer.concat([u32(0x821a01b9), Buffer.alloc(96), u16(payload.length), payload]);
}
const full = (price: bigint): [number, Buffer][] => {
  const b8 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const b2 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
  return [[0, b8(price)], [3, b2(20)], [4, b2(-5)], [5, b8(1000n)], [9, b2(0)], [12, Buffer.concat([Buffer.from([1]), b8(TS)])]];
};

describe("multi-feed message decode", () => {
  it("picks the requested feed out of several, and tolerates other feeds missing properties", async () => {
    const { decodeSolanaMessage } = await import("../src/pyth.ts");
    const m = envelope([{ id: 1314, props: full(18_000_000n) }, { id: 1435, props: full(40_000_000n) }, { id: 922, props: [] }]);
    expect(decodeSolanaMessage(m, 1314).price).toBe(18_000_000n);
    expect(decodeSolanaMessage(m, 1435).price).toBe(40_000_000n);
    expect(() => decodeSolanaMessage(m, 922)).toThrow(/missing property/);
    expect(() => decodeSolanaMessage(m, 1398)).toThrow(/feed not in message/);
  });
  it("rejects a duplicate target feed and an unknown property on another feed", async () => {
    const { decodeSolanaMessage } = await import("../src/pyth.ts");
    expect(() => decodeSolanaMessage(envelope([{ id: 1314, props: full(1n) }, { id: 1314, props: full(2n) }]), 1314)).toThrow(/duplicate feed/);
    expect(() => decodeSolanaMessage(envelope([{ id: 1314, props: full(1n) }, { id: 1435, props: [[7, Buffer.alloc(2)]] }]), 1314)).toThrow(/unexpected property/);
  });
});
