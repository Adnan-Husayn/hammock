import { createServer, type Server } from "node:http";
import { FEED_ID } from "./config.ts";
import type { SignedUpdate } from "./pyth.ts";

export type Leg = "friday" | "monday";

/** Mirrors the on-chain Market fields used by check_eligible. */
export type EligibilityParams = {
  feedId: number; // an update for any other feed is never eligible
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
  if (u.feedId !== p.feedId) return false;
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

/** One signed message can carry several feeds, so entries are keyed by feed and message hash. */
const entryKey = (u: SignedUpdate) => `${u.feedId}:${u.hash}`;

export class Archive {
  private byHash = new Map<string, SignedUpdate>();

  add(u: SignedUpdate): boolean {
    const k = entryKey(u);
    if (this.byHash.has(k)) return false;
    this.byHash.set(k, u);
    return true;
  }

  /** Keep only entries for which `keep` is true; returns how many were dropped. */
  retain(keep: (u: SignedUpdate) => boolean): number {
    let n = 0;
    for (const [k, u] of this.byHash) {
      if (!keep(u)) {
        this.byHash.delete(k);
        n++;
      }
    }
    return n;
  }

  get size() {
    return this.byHash.size;
  }

  /**
   * Drop entries outside every [T - halfWindow, T + halfWindow]; they can never be eligible for those legs. With
   * `feedId`, entries for other feeds are dropped too.
   */
  prune(targetsUs: bigint[], halfWindowUs: bigint, feedId?: number): number {
    return this.retain((u) =>
      (feedId === undefined || u.feedId === feedId) &&
      targetsUs.some((t) => (u.feedTsUs >= t ? u.feedTsUs - t : t - u.feedTsUs) <= halfWindowUs));
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

type LegConfig = { targetUs: bigint; params: EligibilityParams } | undefined;
export type LegLookup = (market: string, leg: Leg) => LegConfig | Promise<LegConfig>;

export function serializeUpdate(u: SignedUpdate) {
  return {
    feedId: u.feedId,
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

/** Inverse of serializeUpdate, for the on-disk archive. */
export function deserializeUpdate(j: Omit<ReturnType<typeof serializeUpdate>, "feedId"> & { feedId?: number }): SignedUpdate {
  // Lines written before multi-market support carry no feed id; they were all NVDA.
  return { ...j, feedId: j.feedId ?? FEED_ID, feedTsUs: BigInt(j.feedTsUs), timestampUs: BigInt(j.timestampUs), price: BigInt(j.price), confidence: BigInt(j.confidence) };
}

export const ARCHIVE_PATH = /^\/archive\/([^/]+)\/(friday|monday)\/?$/;

/** The response for a path matching ARCHIVE_PATH. */
export async function archiveResponse(archive: Archive, lookup: LegLookup, m: RegExpExecArray): Promise<{ status: number; body: unknown }> {
  const cfg = await lookup(decodeURIComponent(m[1]), m[2] as Leg);
  if (!cfg) return { status: 404, body: { error: "unknown market" } };
  return { status: 200, body: { market: m[1], leg: m[2], updates: archive.eligible(cfg.targetUs, cfg.params).map(serializeUpdate) } };
}

/** GET /archive/:market/:leg -> eligible updates, best first. Public data only; no keys. */
export function archiveServer(archive: Archive, lookup: LegLookup): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const m = ARCHIVE_PATH.exec((req.url ?? "").split("?")[0]);
    if (req.method !== "GET" || !m) return send(404, { error: "not found" });
    const r = await archiveResponse(archive, lookup, m);
    send(r.status, r.body);
  });
}
