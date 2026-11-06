import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppDeps } from "./lib/api";
import { fmtUsd, suggestedContracts, type MarketInfo } from "./lib/program";
import { BuyFlow, type BuyStep } from "./components/BuyFlow";
import { BuyPanel } from "./components/BuyPanel";
import { CoverCard } from "./components/CoverCard";
import { Ledger } from "./components/Ledger";
import { PriceTracks } from "./components/PriceTracks";
import { RealCover } from "./components/RealCover";
import { DEMO_REPLAYS, DemoReceipt, Replays, type DemoId } from "./components/Replays";
import { QuickWeekend, Sandbox } from "./components/Sandbox";
import { StateTag, type Certainty } from "./components/StateTag";
import { PRODUCT_NAME } from "./brand";
import { enabledStocks } from "./lib/markets";
import { SAMPLE_PREMIUM } from "./lib/line";
import {
  DEMO_FRIDAY, DEMO_HOLDING, DEMO_MONDAY, DEMO_PREMIUM_PER_CONTRACT, DEMO_WEEKEND_MS, demoWeekend, fmtEtDay, nextWeekend,
  payoutFor, settledStatus, type CoverRecord,
} from "./lib/cover";
import { loadLedger, saveLedger, upsert } from "./lib/ledger";

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
  none: ["Next {sym} cover is not created yet", "Run a demo weekend or pick a replay."],
  created: ["Friday mark not in yet", "Buying starts once it is final."],
  buying: ["Buying now", ""],
  locked: ["Buying has ended", "The Monday morning mark decides the payout."],
  settled: ["Settled", "Both marks are final."],
  voided: ["Voided", "This market did not settle. Buyers can take a refund of the premium."],
};

/** How settled the market is, shown in the status line. */
const CERTAINTY: Record<Phase, Certainty | null> = { none: null, created: "observed", buying: "estimate", locked: "estimate", settled: "final", voided: "final" };

export { DEMO_WEEKEND_MS };

/** The mark: two posts and the line slung between them. */
function Glyph() {
  return (
    <svg className="glyph" width="36" height="24" viewBox="0 0 36 24" aria-hidden="true" focusable="false">
      <path d="M4 2.5 V21.5 M32 2.5 V21.5" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M4 5.5 Q18 23 32 5.5" stroke="var(--signal)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <circle cx="18" cy="16.4" r="3.1" fill="var(--signal)" stroke="var(--ground)" strokeWidth="1.8" />
    </svg>
  );
}

type Flow = { kind: "demo" | "real"; step: BuyStep };

export default function App({ deps, walletButton, onConnectWallet }: { deps: AppDeps; walletButton?: ReactNode; onConnectWallet?: () => void }) {
  const now = deps.now ?? Date.now;
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [premium, setPremium] = useState<number | undefined>();
  const stocks = deps.stocks?.length ? deps.stocks : enabledStocks();
  const [symbol, setSymbol] = useState(stocks[0].symbol);
  const market = deps.realMarkets ? deps.realMarkets[symbol] ?? null : deps.realMarket;

  const [flow, setFlow] = useState<Flow | null>(null);
  const [holding, setHolding] = useState(DEMO_HOLDING);
  const [custom, setCustom] = useState<number | null>(null);
  const contracts = custom ?? suggestedContracts(holding);
  const [demo, setDemo] = useState<CoverRecord | null>(null);
  const [saved, setSaved] = useState<CoverRecord[]>(loadLedger);
  const [real, setReal] = useState<CoverRecord | null>(null);
  const [realNonce, setRealNonce] = useState(0);
  const [howOpen, setHowOpen] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [replay, setReplay] = useState<DemoId | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setInfo(null);
    setPremium(undefined);
    setReal(null);
    if (!market) return setLoaded(true);
    let live = true; // a slow read for the previous stock must not land after a switch
    deps.chain.readMarket(market).then((m) => live && setInfo(m)).catch(() => live && setInfo(null)).finally(() => live && setLoaded(true));
    return () => { live = false; };
  }, [deps.chain, market, realNonce]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const phase = phaseOf(info, now());
  const weekend = useMemo(() => nextWeekend(now()), [now]);
  const buyByTs = info && phase === "buying" ? Number(info.buyingCloseTs) * 1000 : weekend.buyBy;
  const buyBy = fmtEtDay(buyByTs);

  // Demo covers: kept in this browser, written on every status change.
  const record = useCallback((c: CoverRecord) => {
    setDemo(c);
    setSaved((list) => { const next = upsert(list, c); saveLedger(next); return next; });
  }, []);

  const settleDemo = useCallback((c: CoverRecord) => {
    window.clearTimeout(timer.current);
    const done = { ...c, mondayPrice: DEMO_MONDAY };
    record({ ...done, status: settledStatus(payoutFor(done)) });
  }, [record]);

  const confirmDemo = () => {
    const w = demoWeekend(now());
    const c: CoverRecord = {
      id: `demo-${now()}`, kind: "demo", symbol, holding, contracts, premium: Math.round(contracts * DEMO_PREMIUM_PER_CONTRACT * 100) / 100,
      fridayPrice: DEMO_FRIDAY, fridayAt: w.friday, mondayAt: w.monday, mondayPrice: null, status: "Cover active",
    };
    record(c);
    setFlow(null);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => settleDemo(c), DEMO_WEEKEND_MS);
  };

  const toCard = () => setTimeout(() => document.getElementById("cover-card")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  const startDemo = () => { setFlow({ kind: "demo", step: "choose" }); toCard(); };
  const startReal = () => (deps.wallet ? setFlow({ kind: "real", step: "choose" }) : onConnectWallet?.());
  const coverNext = () => (market && phase === "buying" && deps.wallet && !real ? startReal() : startDemo());
  const showHow = () => {
    setHowOpen(true);
    setTimeout(() => document.getElementById("how")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  };

  const ledger = useMemo(() => (real ? [real, ...saved] : saved), [real, saved]);
  const pickStock = (s: string) => { setSymbol(s); setPremium(undefined); };

  const [title, copy] = COPY[phase].map((t) => t.replace("{sym}", symbol));
  const text = phase === "buying" && info ? `Buy cover until ${fmtEt(info.buyingCloseTs)} ET.` : copy;
  const certainty = CERTAINTY[phase];
  const status = loaded ? (
    <p className="status" data-testid="state-card" data-state={phase}>
      {certainty && <><StateTag kind={certainty} /> </>}
      <strong>{phase === "none" ? title : `${symbol}: ${title}`}</strong>.
      {text && <> {text}</>}
      {phase === "buying" && !real && !flow && <> <button className="link" data-testid="buy-real" onClick={startReal}>Choose devnet cover</button></>}
    </p>
  ) : null;

  const perContract = flow?.kind === "real" ? premium ?? SAMPLE_PREMIUM : DEMO_PREMIUM_PER_CONTRACT;
  const preview: CoverRecord = {
    id: "preview", kind: flow?.kind ?? "demo", symbol, holding, contracts, premium: contracts * perContract,
    fridayPrice: null, fridayAt: weekend.friday, mondayAt: weekend.monday, mondayPrice: null, status: "Cover active",
  };
  const holdingLabel = deps.wallet ? "Your holding" : "Demo holding";
  const onLanding = !flow && !demo && !real;
  const holdingText = fmtUsd(holding).replace(/\.00$/, "");
  const headline = <>You hold <span className="money">{holdingText}</span> of {symbol}x.</>;

  const demoActions = demo?.status === "Monday mark final"
    ? <button className="primary" data-testid="claim" onClick={() => record({ ...demo, status: "Claimed" })}>Claim {fmtUsd(payoutFor(demo))} USDC</button>
    : undefined;
  const compressed = demo?.status === "Cover active" ? (
    <p className="compressed" data-testid="compressed">Friday mark in. The demo clock is running.{" "}
      <button className="link" data-testid="skip-monday" onClick={() => settleDemo(demo)}>Go to the Monday mark</button></p>
  ) : undefined;

  return (
    <main>
      <header className="top">
        <span className="brand"><Glyph />{PRODUCT_NAME}</span>
        <div className="row picker" role="group" aria-label="Stock">
          {stocks.map((s) => (
            <button key={s.symbol} className={`pill${s.symbol === symbol ? " is-active" : ""}`} aria-pressed={s.symbol === symbol} onClick={() => pickStock(s.symbol)}>
              {s.symbol}
            </button>
          ))}
        </div>
        <div className="utils"><span className="badge env">Solana devnet, demo tokens</span></div>
        <div className="wallet-slot">{walletButton}</div>
      </header>

      {onLanding && (
        <section className="landing" data-testid="landing">
          <span className="kicker">Weekend gap cover</span>
          <h1 className="hero">{headline}</h1>
          <p className="lead" data-testid="market-closed">Stock market closed for 65h 30m. Token still trades. A Monday mark over 1% below Friday's pays you in USDC, up to {fmtUsd(contracts).replace(/\.00$/, "")}.</p>
          <div className="row actions">
            <button className="primary" data-testid="run-demo" onClick={startDemo}>Run a demo weekend</button>
            <button className="quiet" data-testid="see-how" onClick={showHow}>See how cover works</button>
          </div>
        </section>
      )}
      {!onLanding && <h1 className="hero hero-small">{headline}</h1>}
      {status && <div className="status-line">{status}</div>}
      <div className="row replay-pills" role="group" aria-label="Replays" data-testid="replay-pills">
        <span className="group-label">Replays:</span>
        {DEMO_REPLAYS.map((x) => (
          <button key={x.id} className={`pill${replay === x.id ? " is-active" : ""}`} data-replay-pill aria-pressed={replay === x.id}
            onClick={() => setReplay(replay === x.id ? null : x.id)}>{x.name}</button>
        ))}
      </div>
      {replay && <div className="replay-inline" data-testid="replay-inline"><p className="demo-label">Demo prices, not Pyth, not a settlement</p><DemoReceipt id={replay} /></div>}


      {market && info && (
        <RealCover key={`${market.toBase58()}-${realNonce}`} deps={deps} market={market} info={info} symbol={symbol}
          buyBy={phase === "buying" ? fmtEtDay(Number(info.buyingCloseTs) * 1000) : undefined} onRecord={setReal} />
      )}
      {demo && !(flow?.kind === "demo") && (
        <CoverCard key={demo.id} c={demo} holdingLabel="Demo holding" actions={demoActions} compressed={compressed} />
      )}
      {(onLanding || flow) && <CoverCard key="preview" c={preview} preview holdingLabel={holdingLabel} onRunDemo={startDemo}
        body={flow ? (
        <BuyFlow step={flow.step} kind={flow.kind} stocks={stocks} symbol={symbol} onSymbol={pickStock}
          holding={holding} onHolding={setHolding} contracts={contracts} onContracts={setCustom}
          premiumPerContract={perContract} sample={flow.kind === "demo" || premium === undefined}
          mondayAt={flow.kind === "real" && info ? Number(info.mondayTargetUs / 1000n) : flow.kind === "demo" ? demoWeekend(now()).monday : weekend.monday}
          expiry={flow.kind === "demo" ? "Demo quote, fixed for this run" : "Shown with the live quote below, refreshed every 60 s"}
          confirm={flow.kind === "demo"
            ? <button className="primary" data-testid="confirm-demo" onClick={confirmDemo}>Confirm demo cover</button>
            : market && info ? <BuyPanel deps={deps} market={market} info={info} contracts={contracts} embedded onQuote={setPremium}
                onBought={() => { setFlow(null); setRealNonce((n) => n + 1); }} /> : <p className="note">No devnet market to buy from.</p>}
          onNext={() => setFlow({ ...flow, step: "review" })} onBack={() => setFlow({ ...flow, step: "choose" })} onCancel={() => setFlow(null)} />
        ) : undefined} />}

      <Ledger list={ledger} nextFriday={weekend.friday} buyBy={buyBy} onCoverNext={coverNext} />

      <section className="card how" id="how" data-testid="how">
        <div className="card-head">
          <h2>How cover works</h2>
          <button className="link" aria-expanded={howOpen} onClick={() => setHowOpen((v) => !v)}>{howOpen ? "Hide" : "Show"}</button>
        </div>
        <dl className="mechanics">
          <div><dt>Marks</dt><dd>The payout compares the Friday 16:00 ET mark with the Monday 09:30 ET mark.</dd></div>
          <div><dt>Pyth</dt><dd>Both marks are signed Pyth prices. Token prices over the weekend do not count.</dd></div>
          <div><dt>Band</dt><dd>Nothing at a fall of 1% or less. Rises to $1.00 per contract at 5%. Past 5%, the payout stays at $1.00 and your net loss grows again.</dd></div>
          <div><dt>Size</dt><dd>One contract per $25 of the token keeps net loss flat across the band.</dd></div>
        </dl>
        {howOpen && (
          <>
            {info && <PriceTracks deps={deps} info={info} symbol={symbol} />}
            <Replays deps={deps} />
            <QuickWeekend key={`q-${symbol}`} deps={deps} symbol={symbol} onConnect={onConnectWallet} />
            {sandbox ? <Sandbox key={symbol} deps={deps} symbol={symbol} /> : (
              <p className="note"><button className="link" onClick={() => setSandbox(true)}>Sandbox with step-by-step controls</button></p>
            )}
          </>
        )}
      </section>
      <footer className="note">Devnet only. Pyth marks decide payouts. Token prices and demo prices do not.</footer>
    </main>
  );
}
