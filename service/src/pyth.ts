import { createHash } from "node:crypto";
import WebSocket from "ws";
import { FEED_ID, PYTH_ENDPOINTS, pythToken } from "./config.ts";

export type SignedUpdate = {
  messageHex: string;
  feedTsUs: bigint;
  timestampUs: bigint;
  price: bigint;
  exponent: number;
  confidence: bigint;
  publishers: number;
  session: string;
  hash: string;
};

const SESSIONS = ["regular", "preMarket", "postMarket", "overNight", "closed"];
const norm = (x: string) => x.replace(/[^a-z]/gi, "").toLowerCase();

export type Decoded = {
  timestampUs: bigint;
  feedId: number;
  price: bigint;
  exponent: number;
  confidence: bigint;
  publishers: number;
  session: string;
  feedTsUs: bigint;
};

/** Decode a Solana-format Lazer message exactly as programs/gap_cover/src/pyth.rs parse_report does. Throws on any deviation. */
export function decodeSolanaMessage(buf: Buffer, feedId = FEED_ID): Decoded {
  let pos = 0;
  const take = (n: number) => {
    if (pos + n > buf.length) throw new Error("truncated");
    const b = buf.subarray(pos, pos + n);
    pos += n;
    return b;
  };
  if (take(4).readUInt32LE() !== 0x821a01b9) throw new Error("bad envelope magic");
  take(64 + 32);
  const len = take(2).readUInt16LE();
  if (buf.length !== 4 + 64 + 32 + 2 + len) throw new Error("bad length");
  if (take(4).readUInt32LE() !== 0x93c7d375) throw new Error("bad payload magic");
  const timestampUs = take(8).readBigUInt64LE();
  take(1); // channel
  const nFeeds = take(1)[0];
  let found: Decoded | null = null;
  for (let f = 0; f < nFeeds; f++) {
    const id = take(4).readUInt32LE();
    const nProps = take(1)[0];
    const v: Partial<Decoded> = {};
    for (let k = 0; k < nProps; k++) {
      const prop = take(1)[0];
      const once = (key: keyof Decoded) => { if (v[key] !== undefined) throw new Error("duplicate property"); };
      switch (prop) {
        case 0: once("price"); v.price = take(8).readBigInt64LE(); break;
        case 3: once("publishers"); v.publishers = take(2).readUInt16LE(); break;
        case 4: once("exponent"); v.exponent = take(2).readInt16LE(); break;
        case 5: once("confidence"); v.confidence = take(8).readBigUInt64LE(); break;
        case 9: {
          once("session");
          const n = take(2).readInt16LE();
          if (n < 0 || n >= SESSIONS.length) throw new Error("bad session");
          v.session = SESSIONS[n];
          break;
        }
        case 12:
          once("feedTsUs");
          if (take(1)[0] !== 1) throw new Error("no feed update time");
          v.feedTsUs = take(8).readBigUInt64LE();
          break;
        default: throw new Error("unexpected property");
      }
    }
    if (id === feedId) {
      if (found) throw new Error("duplicate feed");
      if (v.price === undefined || v.publishers === undefined || v.exponent === undefined || v.confidence === undefined || v.session === undefined || v.feedTsUs === undefined) throw new Error("missing property");
      found = { timestampUs, feedId: id, ...(v as Required<typeof v>) } as Decoded;
    }
  }
  if (pos !== buf.length) throw new Error("trailing bytes");
  if (!found) throw new Error("feed not in message");
  return found;
}

/**
 * Turn one `streamUpdated` JSON message into a SignedUpdate, or null when it has no usable feed entry.
 * The signed bytes are decoded and the update is dropped if the parsed JSON disagrees with them in any field.
 */
export function parseStreamMessage(m: any, feedId = FEED_ID): SignedUpdate | null {
  if (m?.type !== "streamUpdated") return null;
  const data: unknown = m.solana?.data;
  const feed = m.parsed?.priceFeeds?.find((f: any) => f.priceFeedId === feedId);
  if (typeof data !== "string" || !feed || feed.price == null || feed.feedUpdateTimestamp == null) return null;
  try {
    const bytes = Buffer.from(data, "hex");
    const d = decodeSolanaMessage(bytes, feedId);
    const u: SignedUpdate = {
      messageHex: data,
      feedTsUs: BigInt(feed.feedUpdateTimestamp),
      timestampUs: BigInt(m.parsed.timestampUs),
      price: BigInt(feed.price),
      exponent: Number(feed.exponent),
      confidence: BigInt(feed.confidence),
      publishers: Number(feed.publisherCount),
      session: String(feed.marketSession),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
    const agree =
      u.feedTsUs === d.feedTsUs && u.timestampUs === d.timestampUs && u.price === d.price && u.exponent === d.exponent &&
      u.confidence === d.confidence && u.publishers === d.publishers && norm(u.session) === norm(d.session);
    return agree ? u : null;
  } catch {
    return null;
  }
}

const SUBSCRIBE = {
  type: "subscribe",
  subscriptionId: 1,
  priceFeedIds: [FEED_ID],
  properties: ["price", "exponent", "confidence", "publisherCount", "marketSession", "feedUpdateTimestamp"],
  formats: ["solana"],
  deliveryFormat: "json",
  jsonBinaryEncoding: "hex",
  parsed: true,
  channel: "fixed_rate@200ms",
};

export type SocketLike = {
  on(ev: "open" | "message" | "error" | "close", cb: (...a: any[]) => void): unknown;
  send(data: string): void;
  terminate(): void;
};

export type StreamOpts = {
  endpoints?: string[];
  token?: string;
  idleMs?: number;
  backoffMs?: [number, number];
  makeSocket?: (url: string, token: string) => SocketLike;
  /** Any frame from an endpoint, parsed or not. For health only. */
  onFrame?: (url: string) => void;
};

/**
 * Stream NVDA from all three endpoints at once (dedup is the archive's job). Each socket has an idle
 * watchdog (no frame for idleMs -> terminate and reconnect) with exponential backoff. Returns a stop function.
 */
export function streamNvda(onUpdate: (u: SignedUpdate) => void, opts: StreamOpts = {}): () => void {
  const endpoints = opts.endpoints ?? PYTH_ENDPOINTS;
  const idleMs = opts.idleMs ?? 3000;
  const [minBack, maxBack] = opts.backoffMs ?? [1000, 15000];
  const token = opts.token ?? pythToken();
  const make = opts.makeSocket ?? ((url, tok) => new WebSocket(url, { headers: { Authorization: `Bearer ${tok}` } }) as unknown as SocketLike);
  let stopped = false;
  const live = new Set<SocketLike>();
  const timers = new Set<NodeJS.Timeout>();

  const connect = (url: string, backoff: number) => {
    if (stopped) return;
    const ws = make(url, token);
    live.add(ws);
    let idle: NodeJS.Timeout | undefined;
    let next = backoff;
    let ended = false;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { try { ws.terminate(); } catch {} end(); }, idleMs);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      live.delete(ws);
      if (stopped) return;
      const t = setTimeout(() => { timers.delete(t); connect(url, Math.min(next * 2, maxBack)); }, next);
      timers.add(t);
    };
    ws.on("open", () => { ws.send(JSON.stringify(SUBSCRIBE)); arm(); });
    ws.on("message", (b: unknown) => {
      if (ended) return;
      arm();
      opts.onFrame?.(url);
      next = minBack; // a live socket resets the backoff
      try {
        const u = parseStreamMessage(JSON.parse(String(b)));
        if (u) onUpdate(u);
      } catch {
        // a malformed frame is dropped; the other endpoints keep delivering
      }
    });
    ws.on("error", () => {}); // never surface the request, which carries the token
    ws.on("close", end);
    arm(); // also covers a socket that never opens
  };
  for (const url of endpoints) connect(url, minBack);

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    for (const s of live) { try { s.terminate(); } catch {} }
  };
}
