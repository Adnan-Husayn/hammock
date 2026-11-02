import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AppDeps } from "./lib/api";
import type { MarketInfo } from "./lib/program";
import { BuyPanel } from "./components/BuyPanel";
import { Calculator } from "./components/Calculator";
import { LockedView } from "./components/LockedView";
import { ProofScreen } from "./components/ProofScreen";
import { Sandbox } from "./components/Sandbox";
import { Settle } from "./components/Settle";
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
  none: ["No {sym} market this weekend", "A new market appears before the Friday afternoon mark."],
  created: ["Waiting for the Friday afternoon mark", "Buying starts once the Friday afternoon mark is final."],
  buying: ["Buying now", ""],
  locked: ["Locked", "Buying has ended. The payout is fixed at the Monday morning mark."],
  settled: ["Settled", "Both marks are final. Claim your payout below."],
  voided: ["Voided", "This market did not settle. Refund your premium below."],
};

export default function App({ deps, walletButton }: { deps: AppDeps; walletButton?: ReactNode }) {
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [contracts, setContracts] = useState(200);
  const [premium, setPremium] = useState<number | undefined>();
  const [sandbox, setSandbox] = useState(false);
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
  const phase = phaseOf(info, (deps.now ?? Date.now)());
  const [title, copy] = COPY[phase].map((t) => t.replace("{sym}", symbol));
  const text = phase === "buying" && info ? `Buy cover until ${fmtEt(info.buyingCloseTs)} ET.` : copy;

  return (
    <main>
      <header>
        <h1>Devnet preview</h1>
        {walletButton}
      </header>
      <p className="lead">Private preview on Solana devnet, with demo tokens.</p>
      <div className="row picker" role="group" aria-label="Stock">
        {stocks.map((s) => (
          <button key={s.symbol} aria-pressed={s.symbol === symbol} className={s.symbol === symbol ? "primary" : undefined} onClick={() => setSymbol(s.symbol)}>
            {s.symbol}
          </button>
        ))}
      </div>
      {loaded && (
        <section className="card state" data-testid="state-card" data-state={phase}>
          <h2>{phase === "none" ? title : `${symbol}: ${title}`}</h2>
          <p>{text}</p>
          <button onClick={() => setSandbox(true)}>Try the sandbox</button>
        </section>
      )}
      <Calculator symbol={symbol} premiumPerContract={premium} onContracts={setContracts} />
      {market && info && phase === "buying" && <BuyPanel deps={deps} market={market} info={info} contracts={contracts} onQuote={onQuote} />}
      {market && info && phase === "locked" && <LockedView deps={deps} market={market} info={info} />}
      {market && info && (phase === "settled" || phase === "voided") && <Settle deps={deps} market={market} info={info} />}
      {market && info && (phase === "settled" || phase === "voided") && <ProofScreen deps={deps} market={market} info={info} />}
      {sandbox && <Sandbox key={symbol} deps={deps} symbol={symbol} />}
    </main>
  );
}
