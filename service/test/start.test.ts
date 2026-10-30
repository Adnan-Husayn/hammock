import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BN, BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startService } from "../src/server.ts";
import type { SignedUpdate } from "../src/pyth.ts";
import { TS, premarket, regular } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const idl = JSON.parse(readFileSync(join(ROOT, "idl", "gap_cover.json"), "utf8"));
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));

async function marketBytes() {
  return new BorshCoder(idl).accounts.encode("Market", {
    dealer: pk(9), bump: 1, vault_bump: 2, feed_id: 1314, exponent: -5, nvdax_mint: pk(10), usdc_mint: pk(11), token_program: pk(12),
    escrow: pk(13), collateral_reserve: pk(14), bounty_reserve: pk(15), friday_target_ts_us: new BN(TS.toString()), monday_target_ts_us: new BN((TS + 240_000_000_000n).toString()),
    buying_close_ts: new BN(0), band_lower_bps: 100, band_upper_bps: 500, friday_conf_cap_bps: 10, monday_conf_cap_bps: 20, min_publishers: 10,
    eligibility_half_window_us: new BN(5_000_000), submission_window_us: new BN(420_000_000), max_contracts: 200, bounty_per_leg: new BN(0),
    claim_deadline_s: new BN(0), dealer_quote_key: pk(16), quote_max_lifetime_s: new BN(90), sandbox: false, demo_authority: pk(17),
    sandbox_mode: { Gap: {} }, creation_multiplier_bits: new BN(0), created_at: new BN(1), state: { FridayFinal: {} }, friday: null, monday: null,
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
