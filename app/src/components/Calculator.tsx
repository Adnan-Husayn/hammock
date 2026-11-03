import { useEffect, useState } from "react";
import { fmtUsd, suggestedContracts } from "../lib/program";
import { tokenName } from "../lib/markets";
import { bandSlope, fmtPct, PARTIAL_COVER_LABEL, readout, SAMPLE_PREMIUM } from "../lib/line";
import { PayoffChart } from "./PayoffChart";

/** The payoff line: net loss on the holding after payout and premium, for any Monday fall from 0% to 8%. */
export function Calculator({ symbol, premiumPerContract, onContracts }: { symbol: string; premiumPerContract?: number; onContracts?: (n: number) => void }) {
  const token = tokenName(symbol);
  const [holding, setHolding] = useState(5000);
  const [fall, setFall] = useState(0.03);
  const [custom, setCustom] = useState<number | null>(null); // null follows the suggested cover
  const suggested = suggestedContracts(holding);
  const contracts = custom ?? suggested;
  const sample = premiumPerContract === undefined;
  const per = premiumPerContract ?? SAMPLE_PREMIUM;
  const r = readout(holding, fall, contracts, per);
  const slope = bandSlope(holding, contracts);
  useEffect(() => onContracts?.(contracts), [contracts, onContracts]);

  const coverNote = contracts === 0 ? "No cover: net loss is the full loss on the holding."
    : Math.abs(slope) < 0.005 ? "Suggested cover: net loss stays flat from a 1% to a 5% fall, then rises again past 5%."
    : slope > 0 ? PARTIAL_COVER_LABEL
    : "Cover above the suggested size: net loss drops inside the band, then rises again past 5%.";

  return (
    <section className="card instrument">
      <div className="card-head">
        <h2>What cover does for your {token}</h2>
        <span className="tag tag-preview">preview</span>
      </div>
      <p className="headline" data-testid="headline">
        At a <span className="num">{fmtPct(fall)}</span> fall: net loss <span className="num loss" data-testid="net-loss">{fmtUsd(r.netLoss)}</span>
      </p>
      <dl className="readout">
        <dt>Loss on {token}</dt><dd className="loss">{fmtUsd(r.holdingLoss)}</dd>
        <dt>Payout</dt><dd>{fmtUsd(r.payout)}</dd>
        <dt>{sample ? "Premium (sample)" : "Premium"}</dt><dd>{fmtUsd(r.premium)}</dd>
      </dl>
      <PayoffChart holding={holding} contracts={contracts} premiumTotal={r.premium} fall={fall} onFall={setFall}
        label={`Net loss on a ${fmtUsd(holding)} ${token} holding with ${contracts} contracts, for a Monday fall from 0% to 8%`} />
      <ul className="legend">
        <li><span className="key key-covered" /> With cover, after payout and premium</li>
        <li><span className="key key-uncovered" /> No cover</li>
        <li><span className="key key-band" /> 1% to 5% band: nothing under 1%, capped at 5%</li>
      </ul>
      <p className="note" data-testid="cover-note">{coverNote}</p>
      <div className="fields">
        <label>{token} holding (USD)
          <input type="number" min={0} step={100} value={holding} onChange={(e) => setHolding(Math.max(0, Number(e.target.value)))} />
        </label>
        <label>{symbol} fall by Monday (%)
          <input type="number" min={0} max={8} step={0.25} value={Number((fall * 100).toFixed(2))} onChange={(e) => setFall(Math.min(0.08, Math.max(0, Number(e.target.value) / 100)))} />
        </label>
        <label>Cover size (contracts)
          <input type="number" min={0} step={10} value={contracts} data-testid="cover-input" onChange={(e) => setCustom(Math.max(0, Math.floor(Number(e.target.value))))} />
        </label>
      </div>
      <p className="note">
        Suggested contracts: <span className="num" data-testid="contracts">{suggested}</span>
        {custom !== null && custom !== suggested && <> <button className="link" onClick={() => setCustom(null)}>Use suggested</button></>}
      </p>
      <p className="note">
        {sample ? `Premium is a sample, $${SAMPLE_PREMIUM} per contract, not a quote. Connect a wallet for a real quote.` : `Premium from the current quote: $${per.toFixed(6)} per contract.`}
        {" "}One contract per $25 of {token}. Each pays nothing at a fall of 1% or less between the Friday afternoon mark and the Monday morning mark, then rises to $1.00 at a fall of 5% or more.
        Moving the marker changes nothing on chain and does not predict Monday.
      </p>
    </section>
  );
}
