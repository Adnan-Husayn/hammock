import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import type { MarketInfo } from "../lib/program";
import { fmtPct } from "../lib/line";
import { PayoffChart } from "./PayoffChart";
import { ProofScreen } from "./ProofScreen";
import { Receipt, measuredFall } from "./Receipt";

export const DEMO_LABEL = "Demo prices, not Pyth, not a settlement";

/** Demo weekends on a $5,000 holding with 200 contracts. Prices are made up; the maths is the real payoff. */
export const DEMO_REPLAYS = [
  { id: "none", name: "No payout", friday: 180, monday: 178.92, voided: false },
  { id: "partial", name: "Partial fall", friday: 180, monday: 175.32, voided: false },
  { id: "cap", name: "Cap", friday: 180, monday: 167.4, voided: false },
  { id: "void", name: "Void", friday: 180, monday: null, voided: true },
] as const;

const HOLDING = 5000, CONTRACTS = 200, PREMIUM = 200 * 0.11955;

function DemoReplay() {
  const [id, setId] = useState<(typeof DEMO_REPLAYS)[number]["id"]>("partial");
  const r = DEMO_REPLAYS.find((x) => x.id === id)!;
  const fall = r.monday === null ? 0 : Math.max(0, measuredFall(r.friday, r.monday));
  return (
    <div data-testid="demo-replay">
      <p className="demo-label" data-testid="demo-label">{DEMO_LABEL}</p>
      <div className="row seg" role="group" aria-label="Demo weekend">
        {DEMO_REPLAYS.map((x) => (
          <button key={x.id} aria-pressed={x.id === id} onClick={() => setId(x.id)}>{x.name}</button>
        ))}
      </div>
      {!r.voided && (
        <PayoffChart holding={HOLDING} contracts={CONTRACTS} premiumTotal={PREMIUM} fall={Math.min(0.08, fall)}
          label={`Demo: net loss at a ${fmtPct(fall)} fall with 200 contracts on $5,000`} />
      )}
      <Receipt d={{
        kind: "demo",
        title: `Demo weekend: ${r.name.toLowerCase()}`,
        friday: r.friday,
        monday: r.monday,
        voided: r.voided,
        voidReason: "Demo void: no Monday mark met the rules, so the market voids and each buyer can take a refund of the premium paid.",
        contracts: CONTRACTS,
      }} />
    </div>
  );
}

function VerifiedReplay({ deps, market }: { deps: AppDeps; market: PublicKey | null }) {
  const [info, setInfo] = useState<MarketInfo | null>(null);
  useEffect(() => {
    if (!market) return;
    let live = true;
    deps.chain.readMarket(market).then((m) => live && setInfo(m)).catch(() => {});
    return () => { live = false; };
  }, [deps, market]);
  if (!market) return <p className="note" data-testid="verified-empty">No settled devnet market is set for this replay yet.</p>;
  if (!info) return <p className="note">Reading the market from devnet.</p>;
  return <ProofScreen deps={deps} market={market} info={info} />;
}

/** Replays anyone can run on any day: Demo (made-up prices) and Verified (a real settled market). */
export function Replays({ deps }: { deps: AppDeps }) {
  const [mode, setMode] = useState<"demo" | "verified">("demo");
  return (
    <section className="card" id="replays">
      <h2>Replay a weekend</h2>
      <div className="row seg" role="group" aria-label="Replay kind">
        <button aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Demo replay</button>
        <button aria-pressed={mode === "verified"} onClick={() => setMode("verified")}>Verified replay</button>
      </div>
      {mode === "demo" ? <DemoReplay /> : <VerifiedReplay deps={deps} market={deps.verifiedMarket ?? null} />}
    </section>
  );
}
