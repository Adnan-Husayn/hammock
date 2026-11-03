import { useState, type ReactNode } from "react";
import { fmtUsd } from "../lib/program";
import { tokenName } from "../lib/markets";
import { bandSlope, fmtFall, fmtPct, PARTIAL_COVER_LABEL, signedUsd } from "../lib/line";
import { PRODUCT_NAME } from "../brand";
import {
  coverFall, coverNumbers, DEMO_LABEL, DEMO_TIME_LABEL, fmtEtDay, measured, receiptText, SIZED_NOTE, sourceLine, statusLabel, sumLine, WEEKEND_NOTE, whatNow, type CoverRecord,
} from "../lib/cover";
import { PayoffChart } from "./PayoffChart";

const SETTLED = new Set(["Monday mark final", "Expired, no payout", "Claimed"]);

/** Saves the receipt as a text file. Quietly does nothing where the browser cannot. */
export function exportReceipt(c: CoverRecord) {
  try {
    const blob = new Blob([receiptText(c, PRODUCT_NAME)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${c.kind === "demo" ? "demo-" : ""}cover-receipt-${c.symbol.toLowerCase()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    // no download support here
  }
}

/**
 * The cover card: a position record. Every field is a fact. The same card goes from preview to
 * Cover active to Monday mark final to Claimed in place; only the middle and the button change.
 */
export function CoverCard({ c, preview, holdingLabel, actions, proof, weekendPrice, buyBy, compressed, body, onRunDemo, onExport = exportReceipt }: {
  c: CoverRecord;
  /** Before any purchase: a sample, labelled as such, with no status. */
  preview?: boolean;
  holdingLabel: "Demo holding" | "Your holding";
  actions?: ReactNode;
  proof?: ReactNode;
  weekendPrice?: number | null;
  buyBy?: string;
  /** Demo progress line while the demo weekend runs. */
  compressed?: ReactNode;
  onExport?: (c: CoverRecord) => void;
  /** Replaces the preview body: the two buy steps happen inside this card. */
  body?: ReactNode;
  /** Shown on the preview's "What happens now?" row. */
  onRunDemo?: () => void;
}) {
  const token = tokenName(c.symbol);
  const [previewFall, setPreviewFall] = useState(0.03);
  const [showProof, setShowProof] = useState(false);
  const settled = !preview && SETTLED.has(c.status);
  const voided = !preview && c.status === "Voided";
  const fall = coverFall(c, previewFall);
  const r = coverNumbers(c, fall);
  const m = measured(c.fridayPrice, c.mondayPrice);
  const slope = bandSlope(c.holding, c.contracts);
  const estimateFall = !settled && !voided && weekendPrice != null && c.fridayPrice ? Math.max(0, (c.fridayPrice - weekendPrice) / c.fridayPrice) : null;

  const actionRow = (
    <div className="card-actions" data-testid="action-row">
      {settled && actions && <p className={`source-line${c.verified ? " is-verified" : ""}`} data-testid="source-line">{sourceLine(c)}</p>}
      <div className="action-buttons">
        {actions}
        <button className="quiet" data-testid="export-receipt" onClick={() => onExport(c)}>Export receipt</button>
      </div>
    </div>
  );

  return (
    <section id="cover-card" className={`card cover-card cover-${c.kind}`} data-testid="cover-card" data-status={preview ? "preview" : c.status}>
      <div className="card-head">
        <div>
          <h2 className="cover-title">{token} weekend cover</h2>
          <p className="cover-holding" data-testid="holding-line">{holdingLabel}: <span className="num">{fmtUsd(c.holding).replace(/\.00$/, "")}</span> {token}</p>
        </div>
        {preview
          ? <span className="status-word status-preview" data-testid="cover-status">Preview</span>
          : <span className={`status-word status-${c.status.split(/[ ,]/)[0].toLowerCase()}`} data-testid="cover-status">{statusLabel(c)}</span>}
      </div>
      {c.kind === "demo" && !preview && <p className="demo-label" data-testid="demo-label">{DEMO_LABEL}</p>}
      {compressed}

      <dl className="facts facts-terms">
        <div><dt>Contracts</dt><dd className="num">{c.contracts}</dd></div>
        <div><dt>Premium</dt><dd className="num">{fmtUsd(c.premium)}</dd></div>
        <div><dt>Payout cap</dt><dd className="num">{fmtUsd(c.contracts)}</dd></div>
      </dl>
      <dl className="facts facts-marks" data-testid="marks">
        <div><dt>Friday mark</dt><dd className="num">{c.fridayPrice === null ? "Not yet" : fmtUsd(c.fridayPrice)}{c.fridayAt && <span className="when">{fmtEtDay(c.fridayAt)}</span>}</dd></div>
        <div><dt>Monday mark</dt><dd className="num">{c.mondayPrice === null ? "Not yet" : fmtUsd(c.mondayPrice)}{c.mondayAt && <span className="when">{fmtEtDay(c.mondayAt)}</span>}</dd></div>
        {c.kind === "demo" && !preview && <p className="marks-note"><span className="badge" data-testid="time-tag">{DEMO_TIME_LABEL}</span></p>}
      </dl>

      {body ? <div className="card-body" data-testid="card-body">{body}</div> : <>
      <p className="what-now" data-testid="what-now"><span className="micro">What happens now?</span> {preview ? "Nothing is bought. Run a demo weekend to see the whole cycle." : whatNow(c, { buyBy })}
        {preview && onRunDemo && <> <button className="quiet inline-run" data-testid="card-run-demo" onClick={onRunDemo}>Run a demo weekend</button></>}</p>

      {voided ? (
        <p className="void-line" data-testid="void-line">Void: no Monday mark, so there is no fall to measure. {c.refunded ? `Refunded: premium ${fmtUsd(c.premium)}.` : `Premium ${fmtUsd(c.premium)} can be refunded.`}</p>
      ) : (
        <>
          <div className="figure">
            <p className="micro">{settled ? `Net loss at the measured ${fmtFall(fall)} fall` : `${preview ? "Preview: " : ""}net loss if Monday falls ${fmtFall(fall)}`}</p>
            <p className="hero-line">
              <span className="big num fig loss" data-testid="net-loss">{signedUsd(-r.netLoss)}</span>
              <span className="compare fig" data-testid="uncovered">without cover {signedUsd(-r.holdingLoss)}</span>
            </p>
          </div>
          {settled && actionRow}
          {settled && (
            <dl className="settled-lines" data-testid="settled-lines">
              <div><dt>Fall</dt><dd className="num">{m !== null && m < 0 ? `${fmtFall(-m)} rise` : fmtFall(fall)}</dd></div>
              <div><dt>Payout</dt><dd className="num">{fmtUsd(r.payout)}</dd></div>
              <div><dt>Premium</dt><dd className="num">{signedUsd(-r.premium)}</dd></div>
            </dl>
          )}
          <p className="sum-line num" data-testid="sum-line">{sumLine(r)}</p>
          <PayoffChart holding={c.holding} contracts={c.contracts} premiumTotal={r.premium} fall={fall}
            onFall={settled ? undefined : setPreviewFall} verified={settled && !!c.verified} markLabel={settled ? `Monday mark${c.kind === "demo" ? " (demo)" : ""} ${fmtPct(fall)}` : undefined} estimateFall={estimateFall}
            label={`Net loss on ${fmtUsd(c.holding)} of ${token} with ${c.contracts} contracts, for a Monday fall from 0% to 8%`} />
          <ul className="legend">
            <li><span className="key key-covered" /> With cover, after payout and premium</li>
            <li><span className="key key-uncovered" /> No cover</li>
            <li><span className="key key-band" /> 1% to 5% band</li>
            {settled && c.verified && <li><span className="key key-verified" /> Measured fall, verified Pyth marks</li>}
          </ul>
          {estimateFall !== null && <p className="note" data-testid="weekend-note">{WEEKEND_NOTE(token)} Last trade {fmtUsd(weekendPrice!)}.</p>}
          {!settled && Math.abs(slope) >= 0.005 && c.contracts > 0 && slope > 0 && <p className="note" data-testid="cover-note">{PARTIAL_COVER_LABEL}</p>}
          {!settled && <p className="note">Moving the marker changes nothing on chain and does not predict Monday.</p>}
        </>
      )}

      {!preview && <p className="note" data-testid="sized-note">{SIZED_NOTE(c.contracts)}</p>}
      {!settled && !preview && actionRow}
      {proof && !preview && (
        <div className="card-foot">
          <button className={`link proof-link${c.verified ? " is-verified" : ""}`} aria-expanded={showProof} onClick={() => setShowProof((v) => !v)}>{showProof ? "Hide the proof" : "See the proof"}</button>
        </div>
      )}
      </>}
      {showProof && proof && <div className="proof" data-testid="proof">{proof}</div>}
    </section>
  );
}
