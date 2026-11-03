import type { ReactNode } from "react";
import { fmtUsd, payoutPerContract } from "../lib/program";
import { fmtPct } from "../lib/line";
import { StateTag } from "./StateTag";

/** Who produced the prices on a receipt. Only "verified" earns the blue badge. */
export type ReceiptKind = "verified" | "chain" | "sandbox" | "demo";

export type ReceiptData = {
  kind: ReceiptKind;
  title: string;
  friday: number | null;
  monday: number | null;
  voided: boolean;
  voidReason?: string;
  contracts: number;
  /** Payout per contract as settled. When absent it is computed from the marks. */
  payoutPerContract?: number;
  signed?: ReactNode;
  escrow?: ReactNode;
  transfer?: ReactNode;
};

const SOURCE: Record<ReceiptKind, string> = {
  verified: "Signed Pyth marks, checked against the archive",
  chain: "Marks read from the market account on chain",
  sandbox: "Sandbox prices, not Pyth",
  demo: "Demo prices, not Pyth, not a settlement",
};

export const measuredFall = (friday: number, monday: number) => (friday - monday) / friday;

/** A plain answer to "why did I get this amount?". The same layout serves demo, sandbox and real markets. */
export function Receipt({ d }: { d: ReceiptData }) {
  const fall = d.friday && d.monday !== null ? measuredFall(d.friday, d.monday) : null;
  const per = d.payoutPerContract ?? (fall === null ? 0 : payoutPerContract(fall));
  const final = d.kind !== "demo";
  const markTag = (has: boolean) => (d.kind === "demo" ? null : has ? <StateTag kind={final ? "final" : "observed"} /> : null);
  return (
    <div className={`receipt receipt-${d.kind}`} data-testid="receipt" data-kind={d.kind}>
      <div className="card-head">
        <h3>{d.title}</h3>
        {d.kind === "verified" ? <span className="badge-verified" data-testid="verified-badge">Verified Pyth proof</span>
          : <span className="source-label" data-testid="source-label">{SOURCE[d.kind]}</span>}
      </div>
      <dl className="lines">
        <dt>Friday afternoon mark {markTag(d.friday !== null)}</dt><dd>{d.friday === null ? "No mark" : fmtUsd(d.friday)}</dd>
        <dt>Monday morning mark {markTag(d.monday !== null)}</dt><dd>{d.monday === null ? "No mark" : fmtUsd(d.monday)}</dd>
        {d.voided ? (
          <><dt>Result</dt><dd>Void</dd></>
        ) : (
          <>
            <dt>Measured fall</dt><dd data-testid="measured-fall">{fall === null ? "Not measured" : fall <= 0 ? `${fmtPct(-fall)} rise` : fmtPct(fall)}</dd>
            <dt>Payout per contract</dt>
            <dd className="arith">{fall === null ? "$0" : `clamp((${fmtPct(Math.max(0, fall))} - 1%) / 4%, 0, 1) = $${per.toFixed(6).replace(/0{1,4}$/, "")}`}</dd>
            <dt>Payout</dt><dd data-testid="receipt-payout">{d.contracts} x ${per.toFixed(6).replace(/0{1,4}$/, "")} = {fmtUsd(d.contracts * per)}</dd>
          </>
        )}
      </dl>
      {d.voided && <p className="note">{d.voidReason ?? "No payout. Each buyer can take a refund of the premium paid."}</p>}
      {d.signed && <div className="signed"><h4>Signed details</h4>{d.signed}</div>}
      {d.escrow && <div className="escrow">{d.escrow}</div>}
      {d.transfer && <div className="transfer">{d.transfer}</div>}
    </div>
  );
}
