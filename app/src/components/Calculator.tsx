import { useEffect, useState } from "react";
import { fmtUsd, netLoss, payoutPerContract, suggestedContracts } from "../lib/program";

export function Calculator({ premiumPerContract, onContracts }: { premiumPerContract?: number; onContracts?: (n: number) => void }) {
  const [holding, setHolding] = useState(5000);
  const [fallPct, setFallPct] = useState(2);
  const contracts = suggestedContracts(holding);
  const fall = fallPct / 100;
  const loss = holding * fall;
  const payout = contracts * payoutPerContract(fall);
  const premium = contracts * (premiumPerContract ?? 0);
  useEffect(() => onContracts?.(contracts), [contracts, onContracts]);
  return (
    <section className="card">
      <h2>What cover does for your NVDAx</h2>
      <div className="fields">
        <label>NVDAx holding (USD)
          <input type="number" min={0} step={100} value={holding} onChange={(e) => setHolding(Math.max(0, Number(e.target.value)))} />
        </label>
        <label>NVDA fall by Monday (%)
          <input type="number" min={0} max={20} step={0.5} value={fallPct} onChange={(e) => setFallPct(Math.max(0, Number(e.target.value)))} />
        </label>
      </div>
      <dl>
        <dt>Suggested contracts</dt><dd data-testid="contracts">{contracts}</dd>
        <dt>Loss on your NVDAx</dt><dd>{fmtUsd(loss)}</dd>
        <dt>Payout</dt><dd>{fmtUsd(payout)}</dd>
        <dt>Premium</dt><dd>{premiumPerContract === undefined ? "No quote yet" : fmtUsd(premium)}</dd>
        <dt><strong>{premiumPerContract === undefined ? "Net loss after payout, before premium" : "Net loss after payout and premium"}</strong></dt><dd data-testid="net-loss"><strong>{fmtUsd(netLoss(holding, fall, contracts, premium))}</strong></dd>
      </dl>
      <p className="note">One contract per $25 of NVDAx. Each pays nothing at a fall of 1% or less between the Friday afternoon mark and the Monday morning mark, then rises to $1.00 at a fall of 5% or more.</p>
    </section>
  );
}
