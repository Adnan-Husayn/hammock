import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Ed25519Program, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finaliseInstruction, finaliseInstructions } from "../src/chain.ts";
import { PYTH_ENDPOINTS, corsOrigin } from "../src/config.ts";
import { decodeMarket } from "../src/quote.ts";
import { autoStopProblem, startService } from "../src/server.ts";
import type { SignedUpdate } from "../src/pyth.ts";
import { TS, premarket, regular } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const idl = JSON.parse(readFileSync(join(ROOT, "idl", "gap_cover.json"), "utf8"));
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));

async function marketBytes(o: { state?: any; friday?: any } = {}) {
  return new BorshCoder(idl).accounts.encode("Market", {
    dealer: pk(9), bump: 1, vault_bump: 2, feed_id: 1314, exponent: -5, nvdax_mint: pk(10), usdc_mint: pk(11), token_program: pk(12),
    escrow: pk(13), collateral_reserve: pk(14), bounty_reserve: pk(15), friday_target_ts_us: new BN(TS.toString()), monday_target_ts_us: new BN((TS + 240_000_000_000n).toString()),
    buying_close_ts: new BN(0), band_lower_bps: 100, band_upper_bps: 500, friday_conf_cap_bps: 10, monday_conf_cap_bps: 20, min_publishers: 10,
    eligibility_half_window_us: new BN(5_000_000), submission_window_us: new BN(420_000_000), max_contracts: 200, bounty_per_leg: new BN(0),
    claim_deadline_s: new BN(0), dealer_quote_key: pk(16), quote_max_lifetime_s: new BN(90), sandbox: false, demo_authority: pk(17),
    sandbox_mode: { Gap: {} }, creation_multiplier_bits: new BN(0), created_at: new BN(1), state: o.state ?? { FridayFinal: {} }, friday: o.friday ?? null, monday: null,
    contracts_sold: 0, total_premiums: new BN(0), open_positions: 0, swept: false, payout_per_contract: new BN(0), buying_closed: false, settled_at: new BN(0),
  });
}

const servers: any[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gap-start-"));
  const key = (name: string) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify([...Keypair.generate().secretKey]));
    return p;
  };
  const devnet = join(dir, "devnet.json");
  writeFileSync(devnet, JSON.stringify({ usdcDemo: { mint: pk(11).toBase58() }, nvdaxTest: { mint: pk(10).toBase58() } }));
  const programId = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const env = {
    GAP_COVER_PROGRAM_ID: programId.toBase58(), SERVICE_PORT: "0", DEVNET_CONFIG_PATH: devnet, REAL_MARKETS: market.toBase58(),
    DEALER_KEYPAIR: key("d"), DEMO_AUTHORITY_KEYPAIR: key("a"), RELAY_KEYPAIR: key("r"),
    ARCHIVE_PATH: join(dir, "archive.jsonl"), FRIDAY_REFS_PATH: join(dir, "refs.json"), SANDBOX_MARKETS_PATH: join(dir, "s.json"),
  } as NodeJS.ProcessEnv;
  return { env, programId, market };
}

async function start(c: ReturnType<typeof setup>, updates: SignedUpdate[]) {
  const data = await marketBytes();
  const conn = {
    getAccountInfo: async (k: PublicKey) => (k.equals(c.market) ? { owner: c.programId, data } : null),
    getBalance: async () => 0,
  } as any;
  const server = await startService(c.env, {
    conn,
    reference: async () => null,
    stream: (f) => { updates.forEach(f); return () => {}; },
  });
  servers.push(server);
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

describe("GET /archive through startService", () => {
  it("serves the stream's eligible reports for a market, and survives a restart", async () => {
    const c = setup();
    const url = await start(c, [regular(), premarket()]);
    const res = await fetch(`${url}/archive/${c.market.toBase58()}/friday`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0]).toMatchObject({ session: "regular", publishers: 20, confidence: "21057", feedTsUs: TS.toString() });

    const url2 = await start(c, []);
    const again: any = await (await fetch(`${url2}/archive/${c.market.toBase58()}/friday`)).json();
    expect(again.updates).toHaveLength(1);
  });

  it("is empty for the other leg and 404s an unknown market or a bad key", async () => {
    const c = setup();
    const url = await start(c, [regular()]);
    const monday: any = await (await fetch(`${url}/archive/${c.market.toBase58()}/monday`)).json();
    expect(monday.updates).toHaveLength(0);
    expect((await fetch(`${url}/archive/${Keypair.generate().publicKey.toBase58()}/friday`)).status).toBe(404);
    expect((await fetch(`${url}/archive/nonsense/friday`)).status).toBe(404);
  });

  it("does not keep reports outside every mark window", async () => {
    const c = setup();
    const url = await start(c, [{ ...regular(), feedTsUs: TS + 60_000_000n, timestampUs: TS + 60_000_000n, hash: "far" }]);
    const body: any = await (await fetch(`${url}/archive/${c.market.toBase58()}/friday`)).json();
    expect(body.updates).toHaveLength(0);
    expect(() => readFileSync(c.env.ARCHIVE_PATH!)).toThrow();
  });

  it("skips a corrupt archive line and keeps the good ones", async () => {
    const c = setup();
    const url = await start(c, [regular()]);
    appendFileSync(c.env.ARCHIVE_PATH!, '{"hash":"cut sho\nnot json\n{}\n');
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const url2 = await start(c, []);
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
    const body: any = await (await fetch(`${url2}/archive/${c.market.toBase58()}/friday`)).json();
    expect(body.updates).toHaveLength(1);
    expect(url).not.toBe(url2);
  });
});

describe("report stream failure at startup", () => {
  const fail = () => { throw new Error("PYTH_PRO_TOKEN missing"); };
  const over = { conn: { getAccountInfo: async () => null } as any, reference: async () => null, stream: fail };

  it("refuses to start with real markets configured", async () => {
    const c = setup();
    await expect(startService(c.env, over)).rejects.toThrow(/PYTH_PRO_TOKEN missing/);
  });

  it("starts a sandbox-only run and logs it", async () => {
    const c = setup();
    delete c.env.REAL_MARKETS;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startService(c.env, over);
    servers.push(server);
    expect(log.mock.calls.flat().join()).toMatch(/sandbox only/);
    log.mockRestore();
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    expect(server.listening).toBe(true);
  });
});

describe("keeper through startService", () => {
  const FRI_CLOSE_MS = Number(TS / 1000n) + 421_000;
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  async function run(c: ReturnType<typeof setup>, opts: { state: any; friday?: any; nowMs: number; updates?: SignedUpdate[]; ref?: number; afterSend?: any }) {
    let bytes = await marketBytes(opts);
    const sent: Transaction[] = [];
    const conn = {
      getAccountInfo: async (k: PublicKey) => (k.equals(c.market) ? { owner: c.programId, data: bytes } : null),
      getBalance: async () => 0,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: async (raw: Buffer) => {
        sent.push(Transaction.from(raw));
        if (opts.afterSend) bytes = await marketBytes({ ...opts, state: opts.afterSend });
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any;
    const clock = { now: opts.nowMs };
    let frame = (_: string) => {};
    const server = await startService(c.env, {
      conn,
      nowMs: () => clock.now,
      keeperIntervalMs: 5,
      healthCheckMs: 5,
      reference: async () => (opts.ref ? ({ price: opts.ref, roundTripBps: 1, multiplier: 1, decimals: 8 }) : null),
      stream: (f, onFrame) => { (opts.updates ?? []).forEach(f); frame = onFrame; return () => {}; },
    });
    servers.push(server);
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    return { sent, clock, frame: (u: string) => frame(u), url: `http://127.0.0.1:${(server.address() as any).port}` };
  }
  const CAND = { price: new BN(1), feed_ts_us: new BN(TS.toString()), submitter: pk(20) };
  const disc = (name: string) => Buffer.from(idl.instructions.find((i: any) => i.name === name).discriminator);
  const refs = (c: ReturnType<typeof setup>) => JSON.parse(readFileSync(c.env.FRIDAY_REFS_PATH!, "utf8"));

  it("submits an archived report in the window, Ed25519 first", async () => {
    const c = setup();
    const r = await run(c, { state: { Created: {} }, nowMs: Number(TS / 1000n) + 3000, updates: [regular()] });
    await until(() => r.sent.length > 0);
    const ixs = r.sent[0].instructions;
    expect(ixs[0].programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ixs[1].programId.equals(c.programId)).toBe(true);
    expect(ixs[1].keys[1].pubkey.equals(c.market)).toBe(true);
  });

  it("finalises Friday after the window and hands f_x over from the keeper, not the poller", async () => {
    const c = setup();
    const r = await run(c, { state: { Created: {} }, friday: CAND, nowMs: FRI_CLOSE_MS, ref: 123.5, afterSend: { FridayFinal: {} } });
    await until(() => r.sent.length > 0);
    const fin = r.sent[0].instructions.at(-1)!;
    expect(Buffer.from(fin.data).equals(disc("finalise_friday"))).toBe(true);
    await until(() => existsSync(c.env.FRIDAY_REFS_PATH!));
    expect(refs(c)[c.market.toBase58()]).toBe(123.5);
  });

  it("creates the token accounts the finalise pays into, and pays with the dealer key", async () => {
    const c = setup();
    const r = await run(c, { state: { Created: {} }, friday: CAND, nowMs: FRI_CLOSE_MS, afterSend: { FridayFinal: {} } });
    await until(() => r.sent.length > 0);
    const ixs = r.sent[0].instructions;
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), c.programId.toBase58()]);
    const dealer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(c.env.DEALER_KEYPAIR!, "utf8"))));
    expect(r.sent[0].feePayer!.equals(dealer.publicKey)).toBe(true);
  });

  it("records no f_x when finalising voids the market", async () => {
    const c = setup();
    const r = await run(c, { state: { Created: {} }, nowMs: FRI_CLOSE_MS, ref: 123.5, afterSend: { Voided: {} } });
    await until(() => r.sent.length > 0);
    await new Promise((res) => setTimeout(res, 50));
    expect(existsSync(c.env.FRIDAY_REFS_PATH!)).toBe(false);
  });

  it("records f_x when it first sees FridayFinal and sends nothing before the Monday window", async () => {
    const c = setup();
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: FRI_CLOSE_MS + 1000, ref: 99 });
    await until(() => existsSync(c.env.FRIDAY_REFS_PATH!));
    expect(refs(c)[c.market.toBase58()]).toBe(99);
    expect(r.sent).toHaveLength(0);
  });

  const GRACE_END_MS = FRI_CLOSE_MS - 1000 + 900_000; // window close + 15 min

  it("still records f_x at the end of the grace period", async () => {
    const c = setup();
    await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: GRACE_END_MS, ref: 77 });
    await until(() => existsSync(c.env.FRIDAY_REFS_PATH!));
    expect(refs(c)[c.market.toBase58()]).toBe(77);
  });

  it("refuses to record f_x past the grace period: logs once, shows in health, and quotes refuse", async () => {
    const c = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: GRACE_END_MS + 1000, ref: 77 });
    await until(() => log.mock.calls.length > 0);
    await new Promise((res) => setTimeout(res, 40));
    const lines = log.mock.calls.flat().filter((l) => /f_x/.test(String(l)));
    log.mockRestore();
    expect(lines).toHaveLength(1);
    expect(existsSync(c.env.FRIDAY_REFS_PATH!)).toBe(false);
    const h: any = await (await fetch(`${r.url}/health`)).json();
    expect(h.ok).toBe(false);
    expect(h.markets[0]).toMatchObject({ fridayRefRecorded: false, fridayRefMissed: true });
  });

  it("clears fridayRefMissed once f_x is added to the file by hand, without a restart", async () => {
    const c = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: GRACE_END_MS + 1000, ref: 77 });
    await until(() => log.mock.calls.length > 0);
    log.mockRestore();
    writeFileSync(c.env.FRIDAY_REFS_PATH!, JSON.stringify({ [c.market.toBase58()]: 61.5 }));
    r.frame(PYTH_ENDPOINTS[0]);
    let h: any;
    for (let i = 0; i < 100; i++) {
      h = await (await fetch(`${r.url}/health`)).json();
      if (!h.markets[0].fridayRefMissed) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(h.markets[0]).toMatchObject({ fridayRefRecorded: true, fridayRefMissed: false });
    expect(h.ok).toBe(true);
  });

  it("keeps an f_x recorded before the grace period ended", async () => {
    const c = setup();
    writeFileSync(c.env.FRIDAY_REFS_PATH!, JSON.stringify({ [c.market.toBase58()]: 50 }));
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: GRACE_END_MS + 60_000, ref: 77 });
    await new Promise((res) => setTimeout(res, 40));
    const h: any = await (await fetch(`${r.url}/health`)).json();
    expect(h.markets[0]).toMatchObject({ fridayRefRecorded: true, fridayRefMissed: false });
    expect(refs(c)[c.market.toBase58()]).toBe(50);
  });

  it("reports health with endpoint ages and keeper status, and no secrets", async () => {
    const c = setup();
    c.env.PYTH_PRO_TOKEN = "super-secret-token";
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: FRI_CLOSE_MS });
    r.frame(PYTH_ENDPOINTS[1]);
    r.clock.now += 7000;
    await new Promise((res) => setTimeout(res, 30));
    const res = await fetch(`${r.url}/health`);
    const text = await res.text();
    expect(res.status).toBe(200);
    const h = JSON.parse(text);
    expect(h.endpoints).toEqual([
      { endpoint: "pyth-lazer-0.dourolabs.app", lastFrameAgeS: null },
      { endpoint: "pyth-lazer-1.dourolabs.app", lastFrameAgeS: 7 },
      { endpoint: "pyth-lazer-2.dourolabs.app", lastFrameAgeS: null },
    ]);
    expect(h.markets[0]).toMatchObject({ market: c.market.toBase58(), state: "FridayFinal", consecutiveFailures: 0, fridayRefRecorded: false });
    expect(text).not.toMatch(/super-secret|https?:|wss:|KEYPAIR/);
  });

  it("counts a failed tick in health and logs it once, without the RPC URL", async () => {
    const c = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const conn = { getAccountInfo: async () => { throw new Error("fetch failed https://rpc.example/?api-key=hidden"); }, getBalance: async () => 0 } as any;
    const server = await startService(c.env, { conn, keeperIntervalMs: 5, reference: async () => null, stream: () => () => {} });
    servers.push(server);
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    await new Promise((res) => setTimeout(res, 60));
    const h: any = await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/health`)).json();
    expect(h.ok).toBe(false);
    expect(h.markets[0].consecutiveFailures).toBeGreaterThan(1);
    const lines = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(lines.match(/keeper /g)).toHaveLength(1);
    expect(lines).not.toMatch(/api-key/);
  });

  it("logs a stream silent over 60 s near a mark at error level, once per silence", async () => {
    const c = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: Number(TS / 1000n) });
    r.frame(PYTH_ENDPOINTS[0]);
    r.frame(PYTH_ENDPOINTS[1]);
    r.frame(PYTH_ENDPOINTS[2]);
    r.clock.now += 59_000;
    await new Promise((res) => setTimeout(res, 30));
    expect(log).not.toHaveBeenCalled();
    r.frame(PYTH_ENDPOINTS[1]);
    r.frame(PYTH_ENDPOINTS[2]);
    r.clock.now += 2_000;
    await until(() => log.mock.calls.length > 0);
    await new Promise((res) => setTimeout(res, 30));
    const lines = log.mock.calls.flat();
    log.mockRestore();
    expect(lines).toEqual(["stream pyth-lazer-0.dourolabs.app silent for 61 s within 10 minutes of a mark"]);
  });

  it("stays quiet about silence away from a mark", async () => {
    const c = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(c, { state: { FridayFinal: {} }, friday: CAND, nowMs: Number(TS / 1000n) + 11 * 60_000 });
    r.clock.now += 120_000;
    await new Promise((res) => setTimeout(res, 30));
    const n = log.mock.calls.length;
    log.mockRestore();
    expect(n).toBe(0);
  });
});

describe("auto-stop with real markets", () => {
  it("flags REAL_MARKETS on a machine that stops when idle, and nothing else", () => {
    expect(autoStopProblem({ AUTO_STOP_MACHINES: "stop" }, 1)).toMatch(/REAL_MARKETS.*fly\.real\.toml/);
    expect(autoStopProblem({ AUTO_STOP_MACHINES: "suspend" }, 1)).toMatch(/suspend/);
    expect(autoStopProblem({ AUTO_STOP_MACHINES: "off" }, 1)).toBeNull();
    expect(autoStopProblem({}, 1)).toBeNull();
    expect(autoStopProblem({ AUTO_STOP_MACHINES: "stop" }, 0)).toBeNull();
  });

  it("logs the error at startup", async () => {
    const c = setup();
    c.env.AUTO_STOP_MACHINES = "stop";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await start(c, []);
    const lines = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(lines).toMatch(/AUTO_STOP_MACHINES=stop/);
  });

  it("the two Fly configs differ only in the stop settings", () => {
    const read = (f: string) => readFileSync(join(ROOT, "service", f), "utf8");
    const sandbox = read("fly.toml"), real = read("fly.real.toml");
    expect(sandbox).toMatch(/auto_stop_machines = "stop"/);
    expect(sandbox).toMatch(/AUTO_STOP_MACHINES = "stop"/);
    expect(real).toMatch(/auto_stop_machines = "off"/);
    expect(real).toMatch(/AUTO_STOP_MACHINES = "off"/);
    expect(real).toMatch(/min_machines_running = 1/);
    const strip = (t: string) => t.split("\n").filter((l) => !/^#|auto_stop|AUTO_STOP|min_machines/i.test(l.trim())).join("\n");
    expect(strip(real)).toBe(strip(sandbox));
  });
});

describe("CORS origin", () => {
  it("is required in production and may not be any origin there", async () => {
    expect(() => corsOrigin({ NODE_ENV: "production" })).toThrow(/CORS_ORIGIN/);
    expect(() => corsOrigin({ NODE_ENV: "production", CORS_ORIGIN: "*" })).toThrow(/CORS_ORIGIN/);
    const c = setup();
    await expect(startService({ ...c.env, NODE_ENV: "production" })).rejects.toThrow(/CORS_ORIGIN/);
  });
  it("defaults to any origin elsewhere and is sent on responses", async () => {
    expect(corsOrigin({})).toBe("*");
    const c = setup();
    c.env.CORS_ORIGIN = "https://app.example";
    const url = await start(c, []);
    const origin = async (path: string, init?: RequestInit) => (await fetch(`${url}${path}`, init)).headers.get("access-control-allow-origin");
    expect(await origin("/health")).toBe("*");
    expect(await origin(`/archive/${c.market.toBase58()}/friday`)).toBe("*");
    expect(await origin(`/archive/${c.market.toBase58()}/monday?x=1`, { method: "OPTIONS" })).toBe("*");
    expect(await origin("/relay")).toBe("https://app.example");
    expect(await origin("/quote")).toBe("https://app.example");
    expect(await origin("/faucet", { method: "OPTIONS" })).toBe("https://app.example");
    expect(await origin("/archive/x")).toBe("https://app.example"); // not an archive route
  });
});

describe("finalise transaction against the IDL", () => {
  it.each(["friday", "monday"] as const)("%s has the IDL's discriminator, account order and flags", async (leg) => {
    const programId = Keypair.generate().publicKey, market = Keypair.generate().publicKey, caller = Keypair.generate().publicKey;
    const mk = decodeMarket(await marketBytes({ state: { FridayFinal: {} } }));
    const sub = pk(30), dealer = pk(31);
    const ix = finaliseInstruction(programId, caller, market, mk, leg, sub, dealer);
    const def = idl.instructions.find((i: any) => i.name === `finalise_${leg}`);
    expect([...ix.data]).toEqual(def.discriminator);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId);
    const byName: Record<string, PublicKey> = {
      caller, market, vault_authority: vault, usdc_mint: mk.usdcMint, nvdax_mint: mk.nvdaxMint, escrow: mk.escrow,
      collateral_reserve: mk.collateralReserve, bounty_reserve: mk.bountyReserve, submitter_usdc: sub, dealer_usdc: dealer, token_program: mk.tokenProgram,
    };
    expect(ix.keys.length).toBe(def.accounts.length);
    def.accounts.forEach((a: any, i: number) => {
      expect(ix.keys[i].pubkey.equals(byName[a.name]), a.name).toBe(true);
      expect(ix.keys[i].isSigner, a.name).toBe(!!a.signer);
      expect(ix.keys[i].isWritable, a.name).toBe(!!a.writable);
    });
  });

  it("uses the dealer's account for the unread submitter slot when no candidate exists", async () => {
    const mk = decodeMarket(await marketBytes({ state: { Created: {} } }));
    const conn = { getAccountInfo: async () => null, getMinimumBalanceForRentExemption: async () => 1 } as any;
    const { instructions: ixs } = await finaliseInstructions(conn, Keypair.generate().publicKey, pk(40), pk(41), mk, "friday");
    expect(ixs).toHaveLength(2);
    const fin = ixs[1];
    expect(fin.keys[8].pubkey.equals(fin.keys[9].pubkey)).toBe(true);
  });
});
