import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AppDeps } from "./lib/api";
import type { MarketInfo } from "./lib/program";
import { BuyPanel } from "./components/BuyPanel";
import { Calculator } from "./components/Calculator";
import { LockedView } from "./components/LockedView";
import { ProofScreen } from "./components/ProofScreen";
import { Sandbox } from "./components/Sandbox";
import { Settle } from "./components/Settle";

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
  none: ["No market this weekend", "A new market appears before the Friday afternoon mark."],
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
  const market = deps.realMarket;

  useEffect(() => {
    if (!market) return setLoaded(true);
    deps.chain.readMarket(market).then(setInfo).catch(() => setInfo(null)).finally(() => setLoaded(true));
  }, [deps.chain, market]);

  const onQuote = useCallback((p: number) => setPremium(p), []);
  const phase = phaseOf(info, (deps.now ?? Date.now)());
  const [title, copy] = COPY[phase];
  const text = phase === "buying" && info ? `Buy cover until ${fmtEt(info.buyingCloseTs)} ET.` : copy;

  return (
    <main>
      <header>
        <h1>Monday Gap Cover</h1>
        {walletButton}
      </header>
      <p className="lead">Keep your NVDAx over the weekend. Get USDC back if NVDA is lower on Monday morning than on Friday afternoon. Built for NVDAx holders.</p>
      {loaded && (
        <section className="card state" data-testid="state-card" data-state={phase}>
          <h2>{title}</h2>
          <p>{text}</p>
          <button onClick={() => setSandbox(true)}>Try the sandbox</button>
        </section>
      )}
      <Calculator premiumPerContract={premium} onContracts={setContracts} />
      {market && info && phase === "buying" && <BuyPanel deps={deps} market={market} info={info} contracts={contracts} onQuote={onQuote} />}
      {market && info && phase === "locked" && <LockedView deps={deps} market={market} info={info} />}
      {market && info && (phase === "settled" || phase === "voided") && <Settle deps={deps} market={market} info={info} />}
      {market && info && (phase === "settled" || phase === "voided") && <ProofScreen deps={deps} market={market} info={info} />}
      {sandbox && <Sandbox deps={deps} />}
    </main>
  );
}
