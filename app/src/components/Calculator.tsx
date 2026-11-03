import { useEffect, useState, type ReactNode } from "react";
import { fmtUsd, suggestedContracts } from "../lib/program";
import { tokenName } from "../lib/markets";
import { bandSlope, equationLine, fmtPct, PARTIAL_COVER_LABEL, readout, SAMPLE_PREMIUM, signedUsd } from "../lib/line";
import { PayoffChart } from "./PayoffChart";

export type InstrumentMode = "Calculator" | "Live market" | "Demo replay" | "Verified replay";

/** A replay drives the instrument with fixed numbers instead of the controls. */
export type ReplayView = { mode: "Demo replay" | "Verified replay"; title: string; holding: number; contracts: number; perContract: number; fall: number };

/**
 * The one instrument: header with controls and market status, the signed equation, and the payoff chart.
 * Net loss on the holding after payout and premium, for any Monday fall from 0% to 8%.
 */
export function Calculator({ symbol, premiumPerContract, onContracts, status, live, replay, onExitReplay }: {
  symbol: string; premiumPerContract?: number; onContracts?: (n: number) => void;
  status?: ReactNode; live?: boolean; replay?: ReplayView | null; onExitReplay?: () => void;
}) {
  const token = tokenName(symbol);
  const [holdingIn, setHolding] = useState(5000);
  const [fallIn, setFall] = useState(0.03);
  const [custom, setCustom] = useState<number | null>(null); // null follows the suggested cover
  const holding = replay?.holding ?? holdingIn;
  const suggested = suggestedContracts(holding);
  const contracts = replay?.contracts ?? custom ?? suggested;
  const fall = replay?.fall ?? fallIn;
  const sample = !replay && premiumPerContract === undefined;
  const per = replay?.perContract ?? premiumPerContract ?? SAMPLE_PREMIUM;
  const r = readout(holding, fall, contracts, per);
  const slope = bandSlope(holding, contracts);
  const userContracts = custom ?? suggestedContracts(holdingIn);
  useEffect(() => onContracts?.(userContracts), [userContracts, onContracts]);
  const mode: InstrumentMode = replay?.mode ?? (live ? "Live market" : "Calculator");

  const coverNote = contracts === 0 ? "No cover: net loss is the full loss on the holding."
    : Math.abs(slope) < 0.005 ? "Suggested cover: net loss stays flat from a 1% to a 5% fall, then rises again past 5%."
    : slope > 0 ? PARTIAL_COVER_LABEL
    : "Cover above the suggested size: net loss drops inside the band, then rises again past 5%.";

  return (
    <section className="card instrument" data-testid="instrument" data-mode={mode}>
      <div className="card-head">
        <h2>What cover does for your {token}</h2>
        <span className={`badge${mode === "Verified replay" ? " badge-verified" : ""}`} data-testid="mode-badge">{mode}</span>
      </div>
      {status && <div className="status-line">{status}</div>}
      <div className="deck">
        <div className="deck-left">
      {replay ? (
        <div className="controls replay-controls">
          <p><strong>{replay.title}</strong>: {fmtUsd(holding)} of {token}, {contracts} contracts, a {fmtPct(fall)} fall.</p>
          <button className="ghost" onClick={onExitReplay}>Back to the calculator</button>
        </div>
      ) : (
        <div className="controls">
          <label>{token} holding (USD)
            <input type="number" min={0} step={100} value={holdingIn} onChange={(e) => setHolding(Math.max(0, Number(e.target.value)))} />
          </label>
          <label>Cover (contracts)
            <input type="number" min={0} step={10} value={contracts} data-testid="cover-input" onChange={(e) => setCustom(Math.max(0, Math.floor(Number(e.target.value))))} />
          </label>
          <label className="fall-field">{symbol} fall by Monday (%)
            <input type="number" min={0} max={8} step={0.25} value={Number((fall * 100).toFixed(2))} onChange={(e) => setFall(Math.min(0.08, Math.max(0, Number(e.target.value) / 100)))} />
          </label>
          <p className="cover-reason">
            Suggested <span className="num" data-testid="contracts">{suggested}</span>, one contract per $25 of {token}
            {custom !== null && custom !== suggested && <> <button className="link" onClick={() => setCustom(null)}>Use suggested</button></>}
          </p>
        </div>
      )}
        </div>
        <div className="deck-right">
      <div className="figure">
        <p className="micro">Net loss at a {fmtPct(fall)} fall</p>
        <p className="big num fig loss" data-testid="net-loss">{fmtUsd(r.netLoss)}</p>
        <p className="compare fig" data-testid="uncovered">without cover {signedUsd(-r.holdingLoss)}</p>
      </div>
        </div>
      </div>
      <div className="eqrow">
      <p className="equation num" data-testid="equation">{equationLine(r)}</p>
      <dl className="readout">
        <dt>Loss</dt><dd className="fig loss">{fmtUsd(r.holdingLoss)}</dd>
        <dt>Payout</dt><dd className="fig">{fmtUsd(r.payout)}</dd>
        <dt>{sample ? "Premium (sample)" : "Premium"}</dt><dd className="fig">{fmtUsd(r.premium)}</dd>
      </dl>
      </div>
      <PayoffChart holding={holding} contracts={contracts} premiumTotal={r.premium} fall={fall} onFall={replay ? undefined : setFall}
        label={`Net loss on a ${fmtUsd(holding)} ${token} holding with ${contracts} contracts, for a Monday fall from 0% to 8%`} />
      <ul className="legend">
        <li><span className="key key-covered" /> With cover, after payout and premium</li>
        <li><span className="key key-uncovered" /> No cover</li>
        <li><span className="key key-band" /> 1% to 5% band</li>
      </ul>
      <p className="note" data-testid="cover-note">{coverNote}</p>
      <p className="note">
        {sample ? `Premium is a sample of $${SAMPLE_PREMIUM} per contract until a wallet gets a real quote.` : `Premium: $${per.toFixed(6)} per contract.`}
        {" "}Moving the marker changes nothing on chain and does not predict Monday.
      </p>
      <dl className="mechanics">
        <div><dt>Marks</dt><dd>The payout compares the Friday afternoon mark with the Monday morning mark.</dd></div>
        <div><dt>Pyth</dt><dd>Both marks are signed Pyth prices. Token prices over the weekend do not count.</dd></div>
        <div><dt>Band</dt><dd>Nothing at a fall of 1% or less. Each contract then rises to $1.00 at 5% or more.</dd></div>
        <div><dt>Size</dt><dd>One contract per $25 of {token} keeps net loss flat across the band.</dd></div>
      </dl>
    </section>
  );
}
