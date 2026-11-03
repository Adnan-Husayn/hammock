import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import { fmtUsd, price, type MarketInfo } from "../lib/program";
import { tokenName } from "../lib/markets";
import { article } from "../lib/line";
import { BuyPanel } from "./BuyPanel";
import { ProofScreen } from "./ProofScreen";
import { Settle } from "./Settle";

/** Shared sandbox state: start a market, buy, ring the bell, settle. */
function useSandbox(deps: AppDeps, symbol: string) {
  const [market, setMarket] = useState<PublicKey | null>(null);
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [bought, setBought] = useState(false);
  const [rung, setRung] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [faucetCount, setFaucetCount] = useState(0);
  const [sig, setSig] = useState<string | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try { await f(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const startMarket = async (mode: "gap" | "multiplierVoid") => {
    const r = await deps.service.startSandbox(mode, symbol);
    const m = new PublicKey(r.market);
    setBought(false); setRung(false); setSig(null);
    setMarket(m);
    setInfo(await deps.chain.readMarket(m));
    return r;
  };
  const fund = async () => {
    if (!deps.wallet) throw new Error("Connect a wallet first");
    await deps.service.faucet(deps.wallet.publicKey.toBase58(), symbol);
    setFaucetCount((n) => n + 1);
  };
  const ring = async (m: PublicKey) => {
    const r = await deps.service.bell(m.toBase58());
    setRung(true);
    const settled = await deps.chain.readMarket(m);
    setInfo(settled);
    return settled?.state === "Voided" ? "The share multiplier changed, so this market is void. Refund your premium below."
      : r.fallBps === null ? "This market settled with no payout."
      : `${symbol} Monday morning mark: ${fmtUsd(price(BigInt(r.mondayPrice)))}, a fall of ${(r.fallBps / 100).toFixed(2)}%.`;
  };
  return { market, info, bought, setBought, rung, note, setNote, busy, faucetCount, sig, setSig, run, startMarket, fund, ring };
}

export function Sandbox({ deps, symbol }: { deps: AppDeps; symbol: string }) {
  const s = useSandbox(deps, symbol);
  const start = (mode: "gap" | "multiplierVoid") => s.run(async () => {
    const r = await s.startMarket(mode);
    s.setNote(`${symbol} Friday afternoon mark set at ${fmtUsd(price(BigInt(r.fridayPrice)))}.`);
  });
  const faucet = () => s.run(async () => {
    await s.fund();
    s.setNote(`Demo USDC and ${tokenName(symbol)} (test) sent to your wallet.`);
  });
  const bell = () => s.run(async () => s.setNote(await s.ring(s.market!)));
  const onBought = useCallback(() => { s.setBought(true); s.setNote("Cover bought: 200 contracts. Now ring the Monday bell."); }, []);

  return (
    <section className="card" id="sandbox">
      <h2>{symbol} sandbox</h2>
      <p>Devnet only, with demo tokens. Fees are covered.</p>
      <div className="row">
        <button disabled={s.busy} onClick={faucet}>Get demo tokens</button>
        <button disabled={s.busy} onClick={() => start("gap")}>Start in gap mode</button>
        <button disabled={s.busy} onClick={() => start("multiplierVoid")}>Start in multiplier-void mode</button>
      </div>
      {s.note && <p className="note">{s.note}</p>}
      {s.market && s.info && !s.rung && !s.bought && <BuyPanel deps={deps} market={s.market} info={s.info} contracts={200} onBought={onBought} balanceNonce={s.faucetCount} />}
      {s.bought && !s.rung && <button className="primary" disabled={s.busy} onClick={bell}>Ring the Monday bell</button>}
      {s.market && s.info && s.rung && <><Settle deps={deps} market={s.market} info={s.info} onSent={s.setSig} /><ProofScreen deps={deps} market={s.market} info={s.info} transferSig={s.sig} /></>}
    </section>
  );
}

const STEPS = ["Demo tokens", "Friday mark", "Buy 200 contracts", "Monday mark", "Claim"] as const;

/**
 * "Test a full weekend": one press funds the wallet and starts a gap-mode market, the buy is one signature,
 * the Monday bell rings by itself after the buy, and the claim is the last signature. Fees are paid for you.
 */
export function QuickWeekend({ deps, symbol, onConnect, state }: { deps: AppDeps; symbol: string; onConnect?: () => void; state?: string }) {
  const s = useSandbox(deps, symbol);
  const [step, setStep] = useState(0);
  const go = () => s.run(async () => {
    setStep(0);
    try { await s.fund(); } catch (e) {
      if (!deps.wallet) throw e;
      s.setNote("Demo tokens were not sent. Trying with what the wallet holds.");
    }
    setStep(1);
    const r = await s.startMarket("gap");
    setStep(2);
    s.setNote(`${symbol} Friday afternoon mark set at ${fmtUsd(price(BigInt(r.fridayPrice)))}. Buy below.`);
  });
  const onBought = useCallback(() => {
    s.setBought(true);
    setStep(3);
    s.run(async () => { s.setNote(await s.ring(s.market!)); setStep(4); });
  }, [s.market]);
  const onSent = useCallback((sig: string) => { s.setSig(sig); setStep(5); }, []);
  return (
    <section className="card quick" id="weekend" data-testid="quick-weekend">
      <div className="strip">
        <div className="strip-text">
          <h2>Run a demo weekend on devnet</h2>
          <p className="note">Demo tokens and network fees are covered. You need a wallet, not real funds.</p>
          {state && <p className="strip-state" data-testid="strip-state">{state}</p>}
        </div>
        <ol className="steps">
          {STEPS.map((t, i) => <li key={t} data-done={i < step} data-now={i === step && (s.market !== null || s.busy)}>{t}</li>)}
        </ol>
        <button className="primary" data-testid="run-weekend" disabled={s.busy} onClick={deps.wallet ? go : onConnect}>
          {s.market ? "Run another weekend" : `Run ${article(symbol)} ${symbol} weekend`}
        </button>
      </div>
      {s.note && <p className="note">{s.note}</p>}
      {s.market && s.info && !s.rung && !s.bought && <BuyPanel deps={deps} market={s.market} info={s.info} contracts={200} onBought={onBought} balanceNonce={s.faucetCount} />}
      {s.market && s.info && s.rung && <><Settle deps={deps} market={s.market} info={s.info} onSent={onSent} /><ProofScreen deps={deps} market={s.market} info={s.info} transferSig={s.sig} contracts={200} /></>}
    </section>
  );
}
