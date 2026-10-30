import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps, ArchiveUpdate } from "../lib/api";
import { fmtTimeUs, fmtUsd, price, usdc, type Candidate, type MarketInfo } from "../lib/program";

function Leg({ title, c, u, sandbox }: { title: string; c: Candidate | null; u?: ArchiveUpdate; sandbox: boolean }) {
  const missing = sandbox ? "Sandbox price" : "Not in archive";
  return (
    <div>
      <h3>{title}</h3>
      {!c ? <p>No mark recorded.</p> : (
        <dl>
          <dt>Signed price</dt><dd>{fmtUsd(price(c.price))}</dd>
          <dt>Session</dt><dd>{u?.session ?? missing}</dd>
          <dt>Timestamp</dt><dd>{fmtTimeUs(c.feedTsUs)}</dd>
          <dt>Publishers</dt><dd>{u ? String(u.publishers) : missing}</dd>
          <dt>Confidence</dt><dd>{u ? fmtUsd(price(BigInt(u.confidence))) : missing}</dd>
        </dl>
      )}
    </div>
  );
}

/** Spec section 9: what Escrow holds in each state. */
export function escrowLine(info: MarketInfo): [string, number] {
  if (info.state === "MondayFinal") return ["Escrow at finalisation, kept for payouts", info.contractsSold * usdc(info.payoutPerContract)];
  if (info.state === "Voided") return ["Escrow at finalisation, kept for refunds", usdc(info.totalPremiums)];
  return ["Escrow before finalisation, fully collateralised", info.contractsSold];
}

export function ProofScreen({ deps, market, info }: { deps: AppDeps; market: PublicKey; info: MarketInfo }) {
  const [fri, setFri] = useState<ArchiveUpdate[]>([]);
  const [mon, setMon] = useState<ArchiveUpdate[]>([]);
  useEffect(() => {
    deps.service.archive(market.toBase58(), "friday").then(setFri).catch(() => {});
    deps.service.archive(market.toBase58(), "monday").then(setMon).catch(() => {});
  }, [deps, market]);
  const match = (list: ArchiveUpdate[], c: Candidate | null) => (c ? list.find((u) => u.feedTsUs === c.feedTsUs.toString()) : undefined);
  const [escrowLabel, escrow] = escrowLine(info);
  return (
    <section className="card">
      <h2>Settlement proof</h2>
      <div className="legs">
        <Leg title="Friday afternoon mark" c={info.friday} u={match(fri, info.friday)} sandbox={info.sandbox} />
        <Leg title="Monday morning mark" c={info.monday} u={match(mon, info.monday)} sandbox={info.sandbox} />
      </div>
      <dl>
        <dt>{escrowLabel}</dt><dd data-testid="escrow">{fmtUsd(escrow)}</dd>
        <dt>Payout per contract</dt><dd>{fmtUsd(usdc(info.payoutPerContract))}</dd>
        <dt>Contracts sold</dt><dd>{info.contractsSold}</dd>
        <dt>Active positions</dt><dd>{info.activePositions}</dd>
      </dl>
    </section>
  );
}
