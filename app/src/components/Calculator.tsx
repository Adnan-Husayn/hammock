import { useEffect, useState, type ReactNode } from "react";
import { fmtUsd, suggestedContracts } from "../lib/program";
import { tokenName } from "../lib/markets";
import { bandSlope, fmtPct, PARTIAL_COVER_LABEL, readout, SAMPLE_PREMIUM, signedUsd } from "../lib/line";
import { PayoffChart } from "./PayoffChart";
import { DEMO_REPLAYS, demoView, type DemoId } from "./Replays";

export type InstrumentMode = "Calculator" | "Live market" | "Demo replay" | "Verified replay";

/** A replay drives the instrument with fixed numbers instead of the controls. */
export type ReplayView = { mode: "Demo replay" | "Verified replay"; title: string; holding: number; contracts: number; perContract: number; fall: number; voided?: boolean };

export type ModeId = "calc" | DemoId;

/** The one signed row: "Stock loss -$150.00 · Payout +$100.00 · Premium -$23.91 · Net -$73.91". */
export function signedRow(r: { holdingLoss: number; payout: number; premium: number; netLoss: number }) {
  return [
    ["Stock loss", signedUsd(-r.holdingLoss)],
    ["Payout", r.payout >= 0.005 ? `+${fmtUsd(r.payout)}` : "$0.00"],
    ["Premium", signedUsd(-r.premium)],
    ["Net", signedUsd(-r.netLoss)],
  ] as const;
}

/**
 * The one instrument: mode pills, controls, the hero figure, one signed arithmetic row and the payoff chart.
 * Net loss on the holding after payout and premium, for any Monday fall from 0% to 8%.
 */
export function Calculator({ symbol, premiumPerContract, onContracts, status, live, modeId: modeIn, onMode, verifiedAvailable, onVerified }: {
  symbol: string; premiumPerContract?: number; onContracts?: (n: number) => void;
  status?: ReactNode; live?: boolean; modeId?: ModeId; onMode?: (m: ModeId) => void; verifiedAvailable?: boolean; onVerified?: () => void;
}) {
  const token = tokenName(symbol);
  const [holdingIn, setHolding] = useState(5000);
  const [fallIn, setFall] = useState(0.03);
  const [custom, setCustom] = useState<number | null>(null); // null follows the suggested cover
  const [ownMode, setOwnMode] = useState<ModeId>("calc");
  const modeId = modeIn ?? ownMode;
  const pick = (m: ModeId) => { setOwnMode(m); onMode?.(m); };
  const replay = modeId === "calc" ? null : demoView(modeId);
  const holding = replay?.holding ?? holdingIn;
  const suggested = suggestedContracts(holding);
  const contracts = replay?.contracts ?? custom ?? suggested;
  const fall = replay?.fall ?? fallIn;
  const sample = !replay && premiumPerContract === undefined;
  const per = replay?.perContract ?? premiumPerContract ?? SAMPLE_PREMIUM;
  const r0 = readout(holding, fall, contracts, per);
  const r = replay?.voided ? { ...r0, holdingLoss: 0, payout: 0, premium: 0, netLoss: 0 } : r0;
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
        <h2>Your cover at a {fmtPct(fall)} fall</h2>
        <div className="row modes" role="group" aria-label="Instrument mode">
          <button className="pill" aria-pressed={modeId === "calc"} onClick={() => pick("calc")}>Calculator</button>
          <span className="badge">demo</span>
          {DEMO_REPLAYS.map((x) => (
            <button key={x.id} className="pill" aria-pressed={modeId === x.id} onClick={() => pick(x.id)}>{x.name}</button>
          ))}
          {verifiedAvailable && <button className="pill pill-verified" onClick={onVerified}>Verified</button>}
        </div>
      </div>
      {status && <div className="status-line">{status}</div>}
      <div className="deck">
        <div className="deck-left">
      {replay ? (
        <div className="controls replay-controls">
          <p data-testid="replay-note"><span className="badge">Demo replay</span> {replay.voided
            ? `Void: no Monday mark met the rules, so each buyer takes back the premium. ${fmtUsd(holding)} of ${token}, ${contracts} contracts.`
            : `${fmtUsd(holding)} of ${token}, ${contracts} contracts, a ${fmtPct(fall)} fall. Demo prices, not Pyth.`}</p>
        </div>
      ) : (
        <div className="controls">
          <label>{token} holding (USD)
            <input type="number" min={0} step={100} value={holdingIn} onChange={(e) => setHolding(Math.max(0, Number(e.target.value)))} />
          </label>
          <label>Cover (contracts)
            <input type="number" min={0} step={10} value={contracts} data-testid="cover-input" onChange={(e) => setCustom(Math.max(0, Math.floor(Number(e.target.value))))} />
          </label>
          <label className="fall-field">{symbol} fall by Monday
            <span className="suffix-wrap">
              <input type="number" min={0} max={8} step={0.25} data-testid="fall-input" value={Number((fall * 100).toFixed(2))} onChange={(e) => setFall(Math.min(0.08, Math.max(0, Number(e.target.value) / 100)))} />
              <span className="suffix" aria-hidden="true">%</span>
            </span>
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
            <p className="micro">{replay?.voided ? "Void, premium refunded" : `Net loss at a ${fmtPct(fall)} fall`}</p>
            <p className="hero-line">
              <span className="big num fig loss" data-testid="net-loss">{signedUsd(-r.netLoss)}</span>
              <span className="compare fig" data-testid="uncovered">without cover {signedUsd(-r.holdingLoss)}</span>
            </p>
          </div>
        </div>
      </div>
      <p className="arith num" data-testid="arith">
        {signedRow(r).map(([k, v], i) => (
          <span key={k} className="fig">{i > 0 && <span className="sep" aria-hidden="true"> · </span>}{k} <strong>{v}</strong></span>
        ))}
      </p>
      <PayoffChart holding={holding} contracts={contracts} premiumTotal={r0.premium} fall={fall} onFall={replay ? undefined : setFall}
        label={`Net loss on a ${fmtUsd(holding)} ${token} holding with ${contracts} contracts, for a Monday fall from 0% to 8%`} />
      <ul className="legend">
        <li><span className="key key-covered" /> With cover, after payout and premium</li>
        <li><span className="key key-uncovered" /> No cover</li>
        <li><span className="key key-band" /> 1% to 5% band</li>
      </ul>
      <p className="note" data-testid="cover-note">{coverNote}</p>
      <p className="note" data-testid="premium-note">
        {sample ? `Sample premium: $${SAMPLE_PREMIUM} per contract. A wallet gets a real quote.` : replay ? "Demo premium: $0.11955 per contract." : `Premium: $${per.toFixed(6)} per contract.`}
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
