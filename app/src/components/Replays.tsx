import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import type { MarketInfo } from "../lib/program";
import { ProofScreen } from "./ProofScreen";
import { Receipt, measuredFall } from "./Receipt";

import { DEMO_LABEL } from "../lib/cover";
export { DEMO_LABEL };

/** Demo weekends on a $5,000 holding with 200 contracts. Prices are made up, the maths is the real payoff. */
export const DEMO_REPLAYS = [
  { id: "none", name: "No payout", friday: 180, monday: 178.92, voided: false },
  { id: "partial", name: "Partial fall", friday: 180, monday: 175.32, voided: false },
  { id: "cap", name: "Cap", friday: 180, monday: 167.4, voided: false },
  { id: "void", name: "Void", friday: 180, monday: null, voided: true },
] as const;

const CONTRACTS = 200;

export type DemoId = (typeof DEMO_REPLAYS)[number]["id"];

/** The receipt for one demo replay. */
export function DemoReceipt({ id }: { id: DemoId }) {
  const r = DEMO_REPLAYS.find((x) => x.id === id)!;
  return (
    <Receipt d={{
      kind: "demo",
      title: `Demo weekend: ${r.name.toLowerCase()}`,
      friday: r.friday,
      monday: r.monday,
      voided: r.voided,
      voidReason: "Demo void: no Monday mark met the rules, so the market voids and each buyer can take a refund of the premium paid.",
      contracts: CONTRACTS,
    }} />
  );
}

function DemoReplay({ selected, onSelect }: { selected?: DemoId; onSelect?: (id: DemoId) => void }) {
  const [own, setOwn] = useState<DemoId>("partial");
  const id = selected ?? own;
  const r = DEMO_REPLAYS.find((x) => x.id === id)!;
  return (
    <div data-testid="demo-replay">
      <p className="demo-label" data-testid="demo-label">{DEMO_LABEL}</p>
      <div className="row seg" role="group" aria-label="Demo weekend">
        {DEMO_REPLAYS.map((x) => (
          <button key={x.id} className="pill" data-replay-pill aria-pressed={x.id === id} onClick={() => { setOwn(x.id); onSelect?.(x.id); }}>{x.name}</button>
        ))}
      </div>
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
export function Replays({ deps, selected, onSelect }: { deps: AppDeps; selected?: DemoId; onSelect?: (id: DemoId) => void }) {
  const [mode, setMode] = useState<"demo" | "verified">("demo");
  return (
    <section className="card" id="replays">
      <h2>Replay a weekend</h2>
      <p className="note">Demo weekends on $5,000 with 200 contracts, one receipt each.</p>
      <div className="row seg" role="group" aria-label="Replay kind">
        <button aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Demo replay</button>
        <button aria-pressed={mode === "verified"} onClick={() => setMode("verified")}>Verified replay</button>
      </div>
      {mode === "demo" ? <DemoReplay selected={selected} onSelect={onSelect} /> : <VerifiedReplay deps={deps} market={deps.verifiedMarket ?? null} />}
    </section>
  );
}
