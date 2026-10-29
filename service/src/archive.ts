import { createServer, type Server } from "node:http";
import type { SignedUpdate } from "./pyth.ts";

export type Leg = "friday" | "monday";

/** Mirrors the on-chain Market fields used by check_eligible. */
export type EligibilityParams = {
  feedId: number; // carried for the caller; the stream only ever carries one feed
  exponent: number;
  halfWindowUs: bigint;
  confCapBps: number;
  minPublishers: number;
};

export type RankKey = readonly [bigint, bigint];

/** math.rs rank_key: (|feedTs - T|, feedTs); lower wins. */
export function rankKey(feedTsUs: bigint, targetUs: bigint): RankKey {
  const d = feedTsUs - targetUs;
  return [d < 0n ? -d : d, feedTsUs];
}

export function rankLess(a: RankKey, b: RankKey): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** pyth.rs check_eligible; true only when every bullet passes. */
export function isEligible(u: SignedUpdate, targetUs: bigint, p: EligibilityParams): boolean {
  if (u.session !== "regular") return false;
  if (u.feedTsUs !== u.timestampUs) return false;
  const d = u.feedTsUs - targetUs;
  if ((d < 0n ? -d : d) > p.halfWindowUs) return false;
  if (u.price <= 0n) return false;
  if (u.exponent !== p.exponent) return false;
  if (u.confidence * 10_000n > u.price * BigInt(p.confCapBps)) return false; // no division
  if (u.publishers < p.minPublishers) return false;
  return true;
}

export class Archive {
  private byHash = new Map<string, SignedUpdate>();

  add(u: SignedUpdate): boolean {
    if (this.byHash.has(u.hash)) return false;
    this.byHash.set(u.hash, u);
    return true;
  }

  get size() {
    return this.byHash.size;
  }

  /** Eligible updates, best first. Equal keys keep arrival order (stable sort), as the chain keeps the earlier. */
  eligible(targetUs: bigint, p: EligibilityParams): SignedUpdate[] {
    return [...this.byHash.values()]
      .filter((u) => isEligible(u, targetUs, p))
      .sort((a, b) => {
        const ka = rankKey(a.feedTsUs, targetUs);
        const kb = rankKey(b.feedTsUs, targetUs);
        return rankLess(ka, kb) ? -1 : rankLess(kb, ka) ? 1 : 0;
      });
  }
}

export type LegLookup = (market: string, leg: Leg) => { targetUs: bigint; params: EligibilityParams } | undefined;

export function serializeUpdate(u: SignedUpdate) {
  return {
    messageHex: u.messageHex,
    hash: u.hash,
    feedTsUs: u.feedTsUs.toString(),
    timestampUs: u.timestampUs.toString(),
    price: u.price.toString(),
    exponent: u.exponent,
    confidence: u.confidence.toString(),
    publishers: u.publishers,
    session: u.session,
  };
}

/** GET /archive/:market/:leg -> eligible updates, best first. Public data only; no keys. */
export function archiveServer(archive: Archive, lookup: LegLookup): Server {
  return createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const m = /^\/archive\/([^/]+)\/(friday|monday)\/?$/.exec((req.url ?? "").split("?")[0]);
    if (req.method !== "GET" || !m) return send(404, { error: "not found" });
    const cfg = lookup(decodeURIComponent(m[1]), m[2] as Leg);
    if (!cfg) return send(404, { error: "unknown market" });
    send(200, { market: m[1], leg: m[2], updates: archive.eligible(cfg.targetUs, cfg.params).map(serializeUpdate) });
  });
}
