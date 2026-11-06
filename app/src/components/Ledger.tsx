import { fmtUsd } from "../lib/program";
import { tokenName } from "../lib/markets";
import { signedUsd } from "../lib/line";
import { fmtEtDay, payoutFor, statusLabel, type CoverKind, type CoverRecord } from "../lib/cover";
import { isActive, totals } from "../lib/ledger";

function Row({ c }: { c: CoverRecord }) {
  return (
    <li className="ledger-row" data-testid="ledger-row" data-status={c.status}>
      <span className="ledger-when">{c.fridayAt ? fmtEtDay(c.fridayAt) : ""}</span>
      <span className="ledger-what">{tokenName(c.symbol)}, {c.contracts} contracts, premium {fmtUsd(c.premium)}{c.status === "Claimed" && <>, payout {fmtUsd(payoutFor(c))}</>}{c.kind === "demo" && <span className="badge">Demo</span>}</span>
      <span className={`ledger-status tag-${c.status.split(/[ ,]/)[0].toLowerCase()}`}>{statusLabel(c)}</span>
    </li>
  );
}

function Totals({ list, kind }: { list: CoverRecord[]; kind: CoverKind }) {
  const t = totals(list, kind);
  if (!t.count) return null;
  return (
    <div className="ledger-totals" data-testid={`totals-${kind}`}>
      <h4>{kind === "demo" ? "Demo totals, no real money" : "Devnet totals, from chain"}</h4>
      <dl>
        <dt>Premiums paid</dt><dd className="num">{fmtUsd(t.premiums)}</dd>
        <dt>Payouts claimed</dt><dd className="num">{fmtUsd(t.payouts)}</dd>
        <dt>Net</dt><dd className="num">{signedUsd(t.net)}</dd>
      </dl>
    </div>
  );
}

/** Every cover so far: active first, then past. Only shown once a cover exists. */
export function Ledger({ list, nextFriday, buyBy, onCoverNext }: { list: CoverRecord[]; nextFriday: number; buyBy: string; onCoverNext: () => void }) {
  if (!list.length) return null;
  const active = list.filter(isActive), past = list.filter((c) => !isActive(c));
  return (
    <section className="card ledger" data-testid="ledger">
      <h2>Your weekends so far</h2>
      {active.length > 0 && <><h3>Active</h3><ul className="ledger-list">{active.map((c) => <Row key={c.id} c={c} />)}</ul></>}
      {past.length > 0 && <><h3>Past</h3><ul className="ledger-list">{past.map((c) => <Row key={c.id} c={c} />)}</ul></>}
      <div className="ledger-sums">
        <Totals list={list} kind="real" />
        <Totals list={list} kind="demo" />
      </div>
      <dl className="ledger-next">
        <dt>Next Friday mark</dt><dd data-testid="next-friday">{fmtEtDay(nextFriday)}</dd>
        <dt>Buy by</dt><dd data-testid="buy-by">{buyBy}</dd>
      </dl>
      <button onClick={onCoverNext} data-testid="cover-next">Cover next weekend</button>
    </section>
  );
}
