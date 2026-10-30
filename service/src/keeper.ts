import { Archive, rankKey, rankLess, type EligibilityParams, type Leg } from "./archive.ts";
import { SUBMISSION_WINDOW_US, SUBMIT_START_US } from "./config.ts";
import type { SignedUpdate } from "./pyth.ts";

export type MarketView = {
  targetUs: Record<Leg, bigint>;
  params: Record<Leg, EligibilityParams>;
  /** On-chain candidate feed timestamp per leg, or null when none is stored. */
  candidateFeedTsUs: Record<Leg, bigint | null>;
  /** Leg already finalised on chain. */
  finalised: Record<Leg, boolean>;
  /** On-chain state name, when the chain knows it. */
  state?: string;
};

export interface Chain {
  readMarket(market: string): Promise<MarketView>;
  /** Resolves true when accepted, false when the report itself was rejected (never retried). Throws on anything transient. */
  submitReport(market: string, leg: Leg, u: SignedUpdate): Promise<boolean>;
  finalise(market: string, leg: Leg): Promise<void>;
}

export type KeeperOptions = {
  /** Called on each tick that finds the market in FridayFinal, including right after finalising Friday. */
  onFridayFinal?(market: string, view: MarketView): Promise<void>;
  /** The shared service archive holds several markets and prunes itself; a keeper then must not. Default true. */
  prune?: boolean;
};

export class Keeper {
  private rejected = new Set<string>();
  private submitted = new Map<string, bigint>(); // `${market}:${leg}` -> best feedTs we got accepted

  private archive: Archive;
  private chain: Chain;
  private nowUs: () => bigint;
  private opts: KeeperOptions;

  // Explicit fields rather than parameter properties so `node --experimental-strip-types` can load this file.
  constructor(archive: Archive, chain: Chain, nowUs: () => bigint, opts: KeeperOptions = {}) {
    this.archive = archive;
    this.chain = chain;
    this.nowUs = nowUs;
    this.opts = opts;
  }

  isRejected(hash: string) {
    return this.rejected.has(hash);
  }

  /** One pass over both legs. Safe to call repeatedly. */
  async tick(market: string): Promise<void> {
    const view = await this.chain.readMarket(market);
    const now = this.nowUs();
    if (this.opts.prune !== false) this.archive.prune([view.targetUs.friday, view.targetUs.monday], view.params.friday.halfWindowUs);
    let firstError: unknown;
    const handOver = async (v: MarketView) => {
      if (v.state === "FridayFinal") await this.opts.onFridayFinal?.(market, v);
    };
    try {
      await handOver(view);
    } catch (e) {
      firstError = e;
    }
    for (const leg of ["friday", "monday"] as Leg[]) {
      try {
        const t = view.targetUs[leg];
        if (view.finalised[leg] || now < t + SUBMIT_START_US) continue;
        if (now > t + SUBMISSION_WINDOW_US) { // finalise.rs: now > close
          await this.chain.finalise(market, leg);
          // Quotes need f_x as soon as buying opens; finalising can also void, so read what it did.
          if (leg === "friday") await handOver(await this.chain.readMarket(market));
          continue;
        }
        await this.submitBest(market, leg, view);
      } catch (e) {
        firstError ??= e; // one leg's failure must not abort the other's pass
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async submitBest(market: string, leg: Leg, view: MarketView) {
    const t = view.targetUs[leg];
    const onChain = view.candidateFeedTsUs[leg];
    const key = `${market}:${leg}`;
    const mine = this.submitted.get(key);
    const bar = [onChain, mine].filter((x): x is bigint => x != null).map((x) => rankKey(x, t))
      .reduce<ReturnType<typeof rankKey> | null>((b, k) => (b && !rankLess(k, b) ? b : k), null);
    for (const u of this.archive.eligible(t, view.params[leg])) {
      if (this.rejected.has(u.hash)) continue;
      // Candidates come best first; the first live one decides whether anything is worth sending.
      if (bar && !rankLess(rankKey(u.feedTsUs, t), bar)) return;
      if (await this.chain.submitReport(market, leg, u)) this.submitted.set(key, u.feedTsUs);
      else this.rejected.add(u.hash);
      return; // one transaction per tick per leg; a rejected one is skipped on the next
    }
  }

  /** Poll until stopped. `onResult` gets null after a clean tick, or what the tick threw. */
  run(market: string, intervalMs = 1000, onResult?: (error: unknown) => void): () => void {
    let stopped = false;
    let busy = false;
    const t = setInterval(async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        await this.tick(market);
        onResult?.(null);
      } catch (e) {
        onResult?.(e); // transient RPC errors retry next tick
      } finally {
        busy = false;
      }
    }, intervalMs);
    return () => { stopped = true; clearInterval(t); };
  }
}
