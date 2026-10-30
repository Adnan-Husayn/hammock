import { ARCHIVE_PATH, Archive, archiveResponse, deserializeUpdate, serializeUpdate, type Leg, type LegLookup } from "./archive.ts";
import { streamNvda, type SignedUpdate } from "./pyth.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { solanaChain } from "./chain.ts";
import { PYTH_ENDPOINTS, corsOrigin, loadConfig } from "./config.ts";
import { StreamHealth, safeError } from "./health.ts";
import { Keeper } from "./keeper.ts";
import { nvdaxReference } from "./jupiter.ts";
import { Freeze, loadGaps } from "./pricing.ts";
import { Quoter, readLastNonce, readMarket, type QuoteResult } from "./quote.ts";
import { RelayRefused, relay, sandboxMarketCheck, type RelayContext } from "./relay.ts";
import { Sandbox, devnetSandboxChain, faucet, type DevnetSetup, type SandboxMode } from "./sandbox.ts";

export type ServiceDeps = {
  quoter: Pick<Quoter, "quote">;
  sandbox: Pick<Sandbox, "start" | "bell">;
  relay(raw: Buffer): Promise<{ transaction: Buffer; user: PublicKey }>;
  faucet(wallet: PublicKey): Promise<string>;
  relayPayer: PublicKey;
  /** Relay key balance in lamports; the relay stops co-signing below RELAY_MIN_LAMPORTS. */
  relayBalance(): Promise<number>;
  nowMs?: () => number;
  /** Behind a reverse proxy (TRUST_PROXY=1): key per-IP limits on the first X-Forwarded-For hop. Off by default. */
  trustProxy?: boolean;
  /** Signed reports kept around each mark; serves GET /archive/:market/:leg. */
  archive?: { archive: Archive; lookup: LegLookup };
  /** Value of Access-Control-Allow-Origin. Defaults to any origin. */
  corsOrigin?: string;
  /** Body of GET /health; public, so it must carry no secrets. */
  health?: () => unknown;
};

const MAX_BODY = 16 * 1024;
export const FAUCET_COOLDOWN_MS = 10 * 60_000;
export const FAUCET_PER_MINUTE = 10; // all wallets together
export const RELAY_PER_MINUTE_IP = 20;
export const RELAY_PER_MINUTE_USER = 10;
export const RELAY_MIN_LAMPORTS = 50_000_000; // 0.05 SOL floor

/** Fixed one-minute window counter. */
export class RateLimit {
  private hits = new Map<string, number[]>();
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  private lastSweep = 0;
  take(key: string, nowMs: number): boolean {
    if (nowMs - this.lastSweep >= 60_000) {
      // Evict keys with no hits in the last minute so the map does not grow without bound.
      for (const [k, v] of this.hits) if (!v.some((t) => nowMs - t < 60_000)) this.hits.delete(k);
      this.lastSweep = nowMs;
    }
    const h = (this.hits.get(key) ?? []).filter((t) => nowMs - t < 60_000);
    if (h.length >= this.limit) return (this.hits.set(key, h), false);
    h.push(nowMs);
    this.hits.set(key, h);
    return true;
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return trustProxy && first ? first : (req.socket.remoteAddress ?? "?");
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function pubkey(v: unknown, name: string): PublicKey {
  try {
    if (typeof v !== "string") throw 0;
    return new PublicKey(v);
  } catch {
    throw new HttpError(400, `${name} must be a base58 public key`);
  }
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function quoteJson(r: Extract<QuoteResult, { ok: true }>) {
  const q = r.quote;
  return {
    market: q.market.toBase58(),
    buyer: q.buyer.toBase58(),
    contracts: q.contracts,
    premiumPerContract: q.premiumPerContract.toString(),
    totalPremium: (q.premiumPerContract * BigInt(q.contracts)).toString(),
    expiry: Number(q.expiry),
    nonce: q.nonce.toString(),
    message: r.message.toString("base64"),
    signature: r.signature.toString("base64"),
    // Data of the Ed25519 instruction to place at index 0, ahead of buy.
    ed25519Data: Buffer.from(r.instruction.data).toString("base64"),
    inputs: r.inputs,
  };
}

/** HTTP API. Keys never leave this process: responses carry public keys and signatures only. */
export function serviceServer(d: ServiceDeps): Server {
  const now = d.nowMs ?? Date.now;
  const lastFaucet = new Map<string, number>();
  const faucetAll = new RateLimit(FAUCET_PER_MINUTE);
  const relayIp = new RateLimit(RELAY_PER_MINUTE_IP);
  const relayUser = new RateLimit(RELAY_PER_MINUTE_USER);
  return createServer(async (req, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", d.corsOrigin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const route = `${req.method} ${url.pathname}`;
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
      const am = req.method === "GET" ? ARCHIVE_PATH.exec(url.pathname) : null;
      if (am && d.archive) {
        const r = await archiveResponse(d.archive.archive, d.archive.lookup, am);
        return send(r.status, r.body);
      }
      if (route === "GET /health" && d.health) return send(200, d.health());
      switch (route) {
        case "GET /quote": {
          const market = pubkey(url.searchParams.get("market"), "market");
          const buyer = pubkey(url.searchParams.get("buyer"), "buyer");
          const contracts = Number(url.searchParams.get("contracts"));
          const r = await d.quoter.quote(market, buyer, contracts);
          return r.ok ? send(200, quoteJson(r)) : send(409, { error: r.reason });
        }
        case "POST /sandbox/start": {
          const { mode } = await body(req);
          if (mode !== "gap" && mode !== "multiplierVoid") throw new HttpError(400, "mode must be gap or multiplierVoid");
          const r = await d.sandbox.start(mode as SandboxMode);
          return send(200, { market: r.market.toBase58(), fridayPrice: r.fridayPrice.toString(), mode: r.mode, relayPayer: d.relayPayer.toBase58() });
        }
        case "POST /sandbox/bell": {
          const market = pubkey((await body(req)).market, "market");
          const r = await d.sandbox.bell(market);
          return send(200, { mode: r.mode, fallBps: r.fallBps, mondayPrice: r.mondayPrice.toString() });
        }
        case "GET /relay": // the fee payer key the app sets on sandbox transactions
          return send(200, { relayPayer: d.relayPayer.toBase58() });
        case "POST /relay": {
          const { transaction } = await body(req);
          if (typeof transaction !== "string") throw new HttpError(400, "transaction must be base64");
          if (!relayIp.take(clientIp(req, d.trustProxy ?? false), now())) throw new HttpError(429, "too many relay requests, try again in a minute");
          if ((await d.relayBalance()) < RELAY_MIN_LAMPORTS) throw new HttpError(503, "relay is out of fee funds");
          const out = await d.relay(Buffer.from(transaction, "base64"));
          if (!relayUser.take(out.user.toBase58(), now())) throw new HttpError(429, "too many relay requests for this wallet, try again in a minute");
          return send(200, { transaction: out.transaction.toString("base64") });
        }
        case "POST /faucet": {
          const wallet = pubkey((await body(req)).wallet, "wallet");
          const k = wallet.toBase58();
          const t = now();
          if (t - (lastFaucet.get(k) ?? -Infinity) < FAUCET_COOLDOWN_MS) throw new HttpError(429, "faucet already used for this wallet, try again later");
          if (!faucetAll.take("all", t)) throw new HttpError(429, "faucet is busy, try again in a minute");
          lastFaucet.set(k, t);
          try {
            return send(200, { signature: await d.faucet(wallet) });
          } catch (e) {
            lastFaucet.delete(k); // a failed drip does not count against the wallet
            throw e;
          }
        }
        default:
          return send(404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e instanceof RelayRefused) return send(400, { error: `relay refused: ${e.message}` });
      const msg = e instanceof Error ? e.message : String(e);
      if (/bell already rung|not a sandbox market/.test(msg)) return send(409, { error: msg });
      console.error(`request failed: ${msg}`);
      return send(500, { error: "internal error" });
    }
  });
}

/* ---------- wiring ---------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Loads a keypair from a file path held in env. The path and key are never logged. */
export function keypairFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Keypair {
  const p = env[name];
  if (!p) throw new Error(`${name} is not set`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

/** Sandbox markets this service started, persisted so the bell still works after a restart. */
class PersistedSet {
  private s: Set<string>;
  private path: string;
  constructor(path: string) {
    this.path = path;
    this.s = new Set(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []);
  }
  has(k: string) {
    return this.s.has(k);
  }
  add(k: string) {
    this.s.add(k);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.s]));
  }
}

/** f_x per market, persisted so a restart keeps it. */
class FridayRefs {
  private m: Record<string, number>;
  private path: string;
  constructor(path: string) {
    this.path = path;
    this.m = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  get(k: PublicKey) {
    return this.m[k.toBase58()];
  }
  set(k: PublicKey, v: number) {
    this.m[k.toBase58()] = v;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.m, null, 2));
  }
}

/** What startService reaches the network for; tests replace these. */
export type ServiceOverrides = {
  conn?: Connection;
  reference?: typeof nvdaxReference;
  stream?: (onUpdate: (u: SignedUpdate) => void, onFrame: (url: string) => void) => () => void;
  nowMs?: () => number;
  keeperIntervalMs?: number;
  healthCheckMs?: number;
};

/**
 * Keeps the stream's reports that fall in a mark's window for a real market, on disk as well, so the proof screen
 * survives a restart between Friday and Monday.
 */
function markArchive(path: string) {
  const archive = new Archive();
  if (existsSync(path)) {
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l) continue;
      try {
        archive.add(deserializeUpdate(JSON.parse(l)));
      } catch {
        console.error("skipped a corrupt archive line"); // for example a write cut short by a crash
      }
    }
  }
  let targets: bigint[] = [];
  let halfWindowUs = 0n;
  return {
    archive,
    setWindows(t: bigint[], half: bigint) {
      targets = t;
      halfWindowUs = half;
      archive.prune(t, half);
    },
    add(u: SignedUpdate) {
      if (!targets.some((t) => (u.feedTsUs >= t ? u.feedTsUs - t : t - u.feedTsUs) <= halfWindowUs)) return;
      if (!archive.add(u)) return;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(serializeUpdate(u)) + "\n");
    },
  };
}

export async function startService(env: NodeJS.ProcessEnv = process.env, over: ServiceOverrides = {}) {
  const cfg = loadConfig(env);
  const allowedOrigin = corsOrigin(env);
  const nowMs = over.nowMs ?? Date.now;
  if (!cfg.programId) throw new Error("GAP_COVER_PROGRAM_ID missing");
  const programId = new PublicKey(cfg.programId);
  const devnet = JSON.parse(readFileSync(env.DEVNET_CONFIG_PATH ?? join(ROOT, "config", "devnet.json"), "utf8"));
  const dealer = keypairFromEnv("DEALER_KEYPAIR", env);
  const demo = keypairFromEnv("DEMO_AUTHORITY_KEYPAIR", env);
  const quoteKey = env.QUOTE_KEYPAIR ? keypairFromEnv("QUOTE_KEYPAIR", env) : dealer;
  const feePayer = keypairFromEnv("RELAY_KEYPAIR", env);
  if ([dealer, demo, quoteKey].some((k) => k.publicKey.equals(feePayer.publicKey))) {
    throw new Error("RELAY_KEYPAIR must be a separate key that holds only SOL for fees");
  }
  const conn = over.conn ?? new Connection(cfg.rpcUrl, "confirmed");
  const reference = over.reference ?? nvdaxReference;
  const freeze = new Freeze();
  const refs = new FridayRefs(env.FRIDAY_REFS_PATH ?? join(ROOT, "logs", "friday-refs.json"));
  const realMarkets = (env.REAL_MARKETS ?? "").split(",").filter(Boolean).map((s) => new PublicKey(s));

  const streamHealth = new StreamHealth(PYTH_ENDPOINTS, nowMs());
  let markTargets: bigint[] = [];
  const marks = markArchive(env.ARCHIVE_PATH ?? join(ROOT, "logs", "archive.jsonl"));
  const refreshWindows = async () => {
    // A failed read keeps the old windows, so a flaky RPC never discards reports.
    const mks = await Promise.all(realMarkets.map((m) => readMarket(conn, programId, m)));
    const known = mks.filter((m) => m !== null);
    markTargets = known.flatMap((m) => [m.eligibility.fridayTargetUs, m.eligibility.mondayTargetUs]);
    marks.setWindows(
      markTargets,
      known.reduce((h, m) => (m.eligibility.halfWindowUs > h ? m.eligibility.halfWindowUs : h), 0n),
    );
  };
  await refreshWindows().catch(() => {});
  setInterval(() => refreshWindows().catch(() => {}), 60_000).unref();

  // Reference refresh every 15 s, for the freeze rule. The keepers record f_x.
  const tick = async () => {
    freeze.update(await reference(), Date.now());
  };
  await tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 15_000).unref();

  const setup: DevnetSetup = {
    conn, programId, dealer, demo, quoteKey: quoteKey.publicKey,
    usdcMint: new PublicKey(devnet.usdcDemo.mint), nvdaxMint: new PublicKey(devnet.nvdaxTest.mint),
  };
  const sandbox = new Sandbox(devnetSandboxChain(setup), {
    reference: () => freeze.current ?? freeze.lastGood,
    recordFridayRef: (m, p) => refs.set(m, p),
    created: new PersistedSet(env.SANDBOX_MARKETS_PATH ?? join(ROOT, "logs", "sandbox-markets.json")),
  });
  const quoter = new Quoter({
    readMarket: (m) => readMarket(conn, programId, m),
    readLastNonce: (m, b) => readLastNonce(conn, programId, m, b),
    freeze,
    fridayRef: (m) => refs.get(m),
    gaps: loadGaps(),
    quoteKey,
    nowMs: Date.now,
    bellRung: (m) => sandbox.bellRung(m),
  });
  const relayCtx: RelayContext = {
    programId,
    feePayer: feePayer.publicKey,
    isSandboxMarket: sandboxMarketCheck(conn, programId),
  };
  const archiveLookup: LegLookup = async (market: string, leg: Leg) => {
    let key: PublicKey;
    try {
      key = new PublicKey(market);
    } catch {
      return undefined;
    }
    const mk = await readMarket(conn, programId, key);
    if (!mk) return undefined;
    const e = mk.eligibility;
    return {
      targetUs: leg === "friday" ? e.fridayTargetUs : e.mondayTargetUs,
      params: { feedId: e.feedId, exponent: e.exponent, halfWindowUs: e.halfWindowUs, confCapBps: leg === "friday" ? e.fridayConfCapBps : e.mondayConfCapBps, minPublishers: e.minPublishers },
    };
  };
  let health: () => unknown = () => ({ ok: false });
  const server = serviceServer({
    corsOrigin: allowedOrigin,
    health: () => health(),
    quoter,
    sandbox,
    relay: (raw) => relay(raw, relayCtx, feePayer),
    faucet: (w) => faucet(setup, w),
    relayPayer: feePayer.publicKey,
    relayBalance: () => conn.getBalance(feePayer.publicKey, "confirmed"),
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    archive: { archive: marks.archive, lookup: archiveLookup },
  });
  let stopStream = () => {};
  try {
    const stream = over.stream ?? ((f, onFrame) => streamNvda(f, { onFrame }));
    stopStream = stream((u) => marks.add(u), (url) => streamHealth.frame(url, nowMs()));
  } catch (e) {
    // Real markets need their marks archived; only a sandbox-only run may go without the stream.
    const why = e instanceof Error ? e.message : String(e);
    if (realMarkets.length > 0) throw new Error(`report stream failed with REAL_MARKETS set: ${why}`);
    console.error(`no report stream, sandbox only: ${why}`);
  }
  // One keeper per real market, each with its own memory of rejected reports. The dealer pays their fees.
  const keeperStatus = realMarkets.map((m) => ({ market: m.toBase58(), state: null as string | null, lastTickMs: null as number | null, lastSuccessMs: null as number | null, consecutiveFailures: 0 }));
  const retryRefAt = new Map<string, number>();
  const handOverFridayRef = async (market: string) => {
    const key = new PublicKey(market);
    if (refs.get(key) !== undefined || nowMs() < (retryRefAt.get(market) ?? 0)) return;
    retryRefAt.set(market, nowMs() + 5_000); // the keeper ticks each second; do not hammer a quote route that is down
    const ref = await reference();
    if (ref) refs.set(key, ref.price);
  };
  const chain = solanaChain(conn, programId, dealer);
  const stopKeepers = keeperStatus.map((status) => {
    const tracked = {
      ...chain,
      async readMarket(market: string) {
        const view = await chain.readMarket(market);
        status.state = view.state ?? null;
        return view;
      },
    };
    let lastLogged = "";
    return new Keeper(marks.archive, tracked, () => BigInt(nowMs()) * 1000n, { onFridayFinal: handOverFridayRef, prune: false }).run(
      status.market,
      over.keeperIntervalMs ?? 1000,
      (error) => {
        status.lastTickMs = nowMs();
        if (error === null) {
          status.lastSuccessMs = status.lastTickMs;
          status.consecutiveFailures = 0;
          lastLogged = "";
          return;
        }
        status.consecutiveFailures++;
        const why = safeError(error);
        if (why !== lastLogged) console.error(`keeper ${status.market}: ${why}`); // once per distinct failure, not each second
        lastLogged = why;
      },
    );
  });
  const healthTimer = setInterval(() => {
    if (realMarkets.length > 0) for (const line of streamHealth.check(nowMs(), markTargets)) console.error(line);
  }, over.healthCheckMs ?? 10_000);
  healthTimer.unref();
  health = () => {
    const now = nowMs();
    const age = (t: number | null) => (t === null ? null : Math.floor((now - t) / 1000));
    return {
      ok: keeperStatus.every((k) => k.consecutiveFailures === 0) && (realMarkets.length === 0 || streamHealth.anyFrameWithin(now, 60_000)),
      endpoints: streamHealth.report(now),
      markets: keeperStatus.map((k) => ({
        market: k.market,
        state: k.state,
        lastTickAgeS: age(k.lastTickMs),
        lastSuccessAgeS: age(k.lastSuccessMs),
        consecutiveFailures: k.consecutiveFailures,
        fridayRefRecorded: refs.get(new PublicKey(k.market)) !== undefined,
      })),
    };
  };
  server.on("close", () => {
    stopStream();
    stopKeepers.forEach((stop) => stop());
    clearInterval(healthTimer);
  });
  server.listen(cfg.httpPort, () => console.log(`dealer service on :${cfg.httpPort}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startService().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
