import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AppDeps } from "./lib/api";
import type { MarketInfo } from "./lib/program";
import { BuyPanel } from "./components/BuyPanel";
import { Calculator } from "./components/Calculator";
import { LockedView } from "./components/LockedView";
import { ProofScreen } from "./components/ProofScreen";
import { Sandbox } from "./components/Sandbox";
import { Settle } from "./components/Settle";
import { PriceTracks } from "./components/PriceTracks";
import { Replays } from "./components/Replays";
import { QuickWeekend } from "./components/Sandbox";
import { StateTag, type Certainty } from "./components/StateTag";
import type { ModeId } from "./components/Calculator";
import { PRODUCT_NAME } from "./brand";
import { enabledStocks } from "./lib/markets";

/** Market buying close in New York time, for example "Sunday 17:50". */
export const fmtEt = (ts: bigint) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(Number(ts) * 1000)).replace(",", "").replace(" at ", " ");

export type Phase = "none" | "created" | "buying" | "locked" | "settled" | "voided";

export function phaseOf(m: MarketInfo | null, nowMs: number): Phase {
  if (!m) return "none";
  if (m.state === "Created") return "created";
  if (m.state === "Voided") return "voided";
  if (m.state === "MondayFinal") return "settled";
  return m.buyingClosed || nowMs / 1000 >= Number(m.buyingCloseTs) ? "locked" : "buying";
}

const COPY: Record<Phase, [string, string]> = {
  none: ["No live {sym} market this weekend", "Try a demo replay or run a demo weekend."],
  created: ["Waiting for the Friday afternoon mark", "Buying starts once it is final."],
  buying: ["Buying now", ""],
  locked: ["Locked", "Buying has ended. The payout is fixed at the Monday morning mark."],
  settled: ["Settled", "Both marks are final. Claim your payout below."],
  voided: ["Voided", "This market did not settle. Refund your premium below."],
};

/** How settled the market is, shown in the status line. */
const CERTAINTY: Record<Phase, Certainty | null> = { none: null, created: "observed", buying: "estimate", locked: "estimate", settled: "final", voided: "final" };

export default function App({ deps, walletButton, onConnectWallet }: { deps: AppDeps; walletButton?: ReactNode; onConnectWallet?: () => void }) {
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [contracts, setContracts] = useState(200);
  const [premium, setPremium] = useState<number | undefined>();
  const [sandbox, setSandbox] = useState(false);
  const [mode, setMode] = useState<ModeId>("calc");
  const stocks = deps.stocks?.length ? deps.stocks : enabledStocks();
  const [symbol, setSymbol] = useState(stocks[0].symbol);
  const market = deps.realMarkets ? deps.realMarkets[symbol] ?? null : deps.realMarket;

  useEffect(() => {
    setInfo(null);
    setPremium(undefined);
    if (!market) return setLoaded(true);
    let live = true; // a slow read for the previous stock must not land after a switch
    deps.chain.readMarket(market).then((m) => live && setInfo(m)).catch(() => live && setInfo(null)).finally(() => live && setLoaded(true));
    return () => { live = false; };
  }, [deps.chain, market]);

  const onQuote = useCallback((p: number) => setPremium(p), []);
  const [sig, setSig] = useState<string | null>(null);
  useEffect(() => setSig(null), [market]);
  const fromReceipts = (m: ModeId) => {
    setMode(m);
    setTimeout(() => document.getElementById("instrument")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  };
  const phase = phaseOf(info, (deps.now ?? Date.now)());
  const [title, copy] = COPY[phase].map((t) => t.replace("{sym}", symbol));
  const text = phase === "buying" && info ? `Buy cover until ${fmtEt(info.buyingCloseTs)} ET.` : copy;
  const certainty = CERTAINTY[phase];
  const stateText = `${phase === "none" ? title : `${symbol}: ${title}`}.${text ? ` ${text}` : ""}`;

  const status = loaded ? (
    <p className="status" data-testid="state-card" data-state={phase}>
      {certainty && <><StateTag kind={certainty} /> </>}
      <strong>{phase === "none" ? title : `${symbol}: ${title}`}</strong>.
      {text && <> {text}</>}
    </p>
  ) : null;

  return (
    <main>
      <header className="top">
        <span className="brand">{PRODUCT_NAME}</span>
        <div className="row picker" role="group" aria-label="Stock">
          {stocks.map((s) => (
            <button key={s.symbol} className="pill" aria-pressed={s.symbol === symbol} onClick={() => { setSymbol(s.symbol); setMode("calc"); }}>
              {s.symbol}
            </button>
          ))}
          <span className="badge env">Solana devnet, demo tokens</span>
        </div>
        <div className="wallet-slot">{walletButton}</div>
      </header>
      <h1 className="hero">Keep the token. Know your loss on a 1% to 5% Monday fall.</h1>
      <p className="lead">If the Monday Pyth mark is more than 1% below Friday's, you are paid in USDC, rising to the full payout at a 5% fall.</p>
      <QuickWeekend key={`q-${symbol}`} deps={deps} symbol={symbol} onConnect={onConnectWallet} state={loaded ? stateText : undefined} />
      <div id="instrument">
        <Calculator symbol={symbol} premiumPerContract={premium} onContracts={setContracts} status={status}
          live={!!info && phase !== "none"} modeId={mode} onMode={setMode}
          verifiedAvailable={!!deps.verifiedMarket} onVerified={() => document.getElementById("replays")?.scrollIntoView?.({ behavior: "smooth" })} />
      </div>
      {info && <section className="card"><PriceTracks deps={deps} info={info} symbol={symbol} /></section>}
      {market && info && phase === "buying" && <BuyPanel deps={deps} market={market} info={info} contracts={contracts} onQuote={onQuote} />}
      {market && info && phase === "locked" && <LockedView deps={deps} market={market} info={info} />}
      {market && info && (phase === "settled" || phase === "voided") && <Settle deps={deps} market={market} info={info} onSent={setSig} />}
      {market && info && (phase === "settled" || phase === "voided") && <ProofScreen deps={deps} market={market} info={info} transferSig={sig} />}
      <Replays deps={deps} selected={mode === "calc" ? undefined : mode} onSelect={fromReceipts} />
      {sandbox ? <Sandbox key={symbol} deps={deps} symbol={symbol} /> : (
        <p className="note"><button className="link" onClick={() => setSandbox(true)}>Sandbox with step-by-step controls</button></p>
      )}
      <footer className="note">Devnet only. Pyth marks decide payouts. Token prices and demo prices do not.</footer>
    </main>
  );
}
