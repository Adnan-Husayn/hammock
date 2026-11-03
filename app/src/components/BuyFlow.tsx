import type { ReactNode } from "react";
import { fmtUsd, suggestedContracts } from "../lib/program";
import { tokenName, type Stock } from "../lib/markets";
import { fmtFall, readout, signedUsd } from "../lib/line";
import { fmtEtDay, OUTCOME_FALLS } from "../lib/cover";

export type BuyStep = "choose" | "review";
export const STEP_NAMES: Record<BuyStep, string> = { choose: "Choose cover", review: "Review & confirm" };

/**
 * Buying in two steps. Step 1 picks stock, holding and contracts. Step 2 shows what the cover costs and does,
 * then hands over to the confirm control (a demo button, or the real quote and wallet signature).
 */
export function BuyFlow({ step, kind, stocks, symbol, onSymbol, holding, onHolding, contracts, onContracts, premiumPerContract, sample, mondayAt, expiry, confirm, onNext, onBack, onCancel }: {
  step: BuyStep; kind: "demo" | "real";
  stocks: Stock[]; symbol: string; onSymbol: (s: string) => void;
  holding: number; onHolding: (n: number) => void;
  contracts: number; onContracts: (n: number | null) => void;
  premiumPerContract: number; sample: boolean; mondayAt: number;
  expiry: ReactNode; confirm: ReactNode;
  onNext: () => void; onBack: () => void; onCancel: () => void;
}) {
  const token = tokenName(symbol);
  const suggested = suggestedContracts(holding);
  const premium = contracts * premiumPerContract;
  return (
    <section className="card buy-flow" data-testid="buy-flow" data-step={step} aria-label={kind === "demo" ? "Demo cover" : "Devnet cover"}>
      <ol className="buy-steps">
        {(["choose", "review"] as const).map((s, i) => (
          <li key={s} aria-current={s === step ? "step" : undefined}>{i + 1}. {STEP_NAMES[s]}</li>
        ))}
      </ol>
      {step === "choose" ? (
        <>
          <h2>{STEP_NAMES.choose}</h2>
          <div className="row picker" role="group" aria-label="Cover stock">
            {stocks.map((s) => (
              <button key={s.symbol} className={`pill${s.symbol === symbol ? " is-active" : ""}`} aria-pressed={s.symbol === symbol} onClick={() => onSymbol(s.symbol)}>{s.symbol}</button>
            ))}
          </div>
          <div className="controls">
            <label>{token} holding (USD)
              <input type="number" min={0} step={100} value={holding} data-testid="holding-input" onChange={(e) => onHolding(Math.max(0, Number(e.target.value)))} />
            </label>
            <label>Contracts
              <input type="number" min={0} step={10} value={contracts} data-testid="cover-input" onChange={(e) => onContracts(Math.max(0, Math.floor(Number(e.target.value))))} />
            </label>
            <p className="cover-reason">
              Suggested <span className="num" data-testid="contracts">{suggested}</span>, one contract per $25 of {token}
              {contracts !== suggested && <> <button className="link" onClick={() => onContracts(null)}>Use suggested</button></>}
            </p>
          </div>
          <div className="row">
            <button className="primary" data-testid="to-review" disabled={contracts <= 0} onClick={onNext}>Next: {STEP_NAMES.review}</button>
            <button className="quiet" onClick={onCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <h2>{STEP_NAMES.review}</h2>
          <dl className="review" data-testid="review">
            <dt>Cover</dt><dd>{contracts} contracts on {fmtUsd(holding).replace(/\.00$/, "")} of {token}</dd>
            <dt>Premium</dt><dd className="num" data-testid="review-premium">{fmtUsd(premium)} <span className="note">({premiumPerContract.toFixed(5)} per contract{sample ? ", demo" : ""})</span></dd>
            <dt>Payout cap</dt><dd className="num">{fmtUsd(contracts)}, reached at a 5% fall</dd>
            <dt>Band</dt><dd>Nothing at a fall of 1% or less. Rises to $1.00 per contract at 5%. Losses past 5% are not covered.</dd>
            <dt>Monday mark</dt><dd>{fmtEtDay(mondayAt)}</dd>
            <dt>Quote expiry</dt><dd>{expiry}</dd>
          </dl>
          <table className="outcomes" data-testid="outcomes">
            <caption className="micro">Outcome on your holding</caption>
            <thead><tr><th scope="col">Monday fall</th><th scope="col">Net loss</th><th scope="col">Without cover</th></tr></thead>
            <tbody>
              {OUTCOME_FALLS.map((f) => {
                const r = readout(holding, f, contracts, premiumPerContract);
                return <tr key={f}><th scope="row">{fmtFall(f)}</th><td className="num">{signedUsd(-r.netLoss)}</td><td className="num">{signedUsd(-r.holdingLoss)}</td></tr>;
              })}
            </tbody>
          </table>
          <div className="row confirm-row">
            {confirm}
            <button className="quiet" onClick={onBack}>Back</button>
          </div>
        </>
      )}
    </section>
  );
}
