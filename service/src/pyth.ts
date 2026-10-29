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

/** Turn one `streamUpdated` JSON message into a SignedUpdate, or null when it has no usable feed entry. */
export function parseStreamMessage(m: any, feedId = FEED_ID): SignedUpdate | null {
  if (m?.type !== "streamUpdated") return null;
  const data: unknown = m.solana?.data;
  const feed = m.parsed?.priceFeeds?.find((f: any) => f.priceFeedId === feedId);
  if (typeof data !== "string" || !feed || feed.price == null || feed.feedUpdateTimestamp == null) return null;
  const bytes = Buffer.from(data, "hex");
  return {
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

/** Stream NVDA from all three endpoints at once (dedup is the archive's job). Returns a stop function. */
export function streamNvda(onUpdate: (u: SignedUpdate) => void, endpoints = PYTH_ENDPOINTS): () => void {
  let stopped = false;
  const sockets = new Set<WebSocket>();
  const timers = new Set<NodeJS.Timeout>();
  const token = pythToken();

  const connect = (url: string) => {
    if (stopped) return;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    sockets.add(ws);
    ws.on("open", () => ws.send(JSON.stringify(SUBSCRIBE)));
    ws.on("message", (b) => {
      try {
        const u = parseStreamMessage(JSON.parse(String(b)));
        if (u) onUpdate(u);
      } catch {
        // a malformed frame is dropped; the other endpoints keep delivering
      }
    });
    ws.on("error", () => {}); // never surface the request, which carries the token
    ws.on("close", () => {
      sockets.delete(ws);
      if (stopped) return;
      const t = setTimeout(() => { timers.delete(t); connect(url); }, 1000);
      timers.add(t);
    });
  };
  for (const url of endpoints) connect(url);

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    for (const s of sockets) { try { s.close(); } catch {} }
  };
}
