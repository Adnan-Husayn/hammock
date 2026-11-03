import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps, ArchiveUpdate } from "../lib/api";
import { fmtTimeUs, fmtUsd, price, usdc, type Candidate, type MarketInfo } from "../lib/program";
import { Receipt } from "./Receipt";

export const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

function Leg({ title, c, u, sandbox }: { title: string; c: Candidate | null; u?: ArchiveUpdate; sandbox: boolean }) {
  const missing = sandbox ? "Sandbox price" : "Not in archive";
  return (
    <div>
      <h5>{title}</h5>
      {!c ? <p>No mark recorded.</p> : (
        <dl className="mono">
          <dt>{sandbox ? "Demo price" : "Signed price"}</dt><dd>{fmtUsd(price(c.price))}</dd>
          <dt>Session</dt><dd>{u?.session ?? missing}</dd>
          <dt>Timestamp</dt><dd>{fmtTimeUs(c.feedTsUs)}</dd>
          <dt>Publishers</dt><dd>{u ? String(u.publishers) : missing}</dd>
          <dt>Confidence</dt><dd>{u ? fmtUsd(price(BigInt(u.confidence))) : missing}</dd>
          {u && <><dt>Hash</dt><dd className="hash">{u.hash}</dd></>}
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

/** The settlement receipt for a market on chain: marks, fall, arithmetic, signed details, escrow and the transfer. */
export function ProofScreen({ deps, market, info, transferSig, contracts }: {
  deps: AppDeps; market: PublicKey; info: MarketInfo; transferSig?: string | null; contracts?: number;
}) {
  const [fri, setFri] = useState<ArchiveUpdate[]>([]);
  const [mon, setMon] = useState<ArchiveUpdate[]>([]);
  useEffect(() => {
    deps.service.archive(market.toBase58(), "friday").then(setFri).catch(() => {});
    deps.service.archive(market.toBase58(), "monday").then(setMon).catch(() => {});
  }, [deps, market]);
  const match = (list: ArchiveUpdate[], c: Candidate | null) => (c ? list.find((u) => u.feedTsUs === c.feedTsUs.toString()) : undefined);
  const uf = match(fri, info.friday), um = match(mon, info.monday);
  const [escrowLabel, escrow] = escrowLine(info);
  const voided = info.state === "Voided";
  const final = info.state === "MondayFinal";
  const kind = info.sandbox ? "sandbox" : final && uf && um ? "verified" : "chain";
  return (
    <section className="card">
      <h2>Settlement receipt</h2>
      <Receipt d={{
        kind,
        title: voided ? "Void: premiums are refunded" : final ? "Why the payout is this amount" : "Before the Monday mark",
        friday: info.friday ? price(info.friday.price) : null,
        monday: info.monday ? price(info.monday.price) : null,
        voided,
        contracts: contracts ?? info.contractsSold,
        payoutPerContract: final ? usdc(info.payoutPerContract) : undefined,
        signed: (
          <div className="legs">
            <Leg title="Friday afternoon mark" c={info.friday} u={uf} sandbox={info.sandbox} />
            <Leg title="Monday morning mark" c={info.monday} u={um} sandbox={info.sandbox} />
          </div>
        ),
        escrow: (
          <dl>
            <dt>{escrowLabel}</dt><dd data-testid="escrow">{fmtUsd(escrow)}</dd>
            <dt>Escrow account</dt><dd className="mono"><a href={explorer("address", info.escrow.toBase58())} target="_blank" rel="noreferrer">{info.escrow.toBase58().slice(0, 8)}...</a></dd>
            <dt>Contracts sold</dt><dd>{info.contractsSold}</dd>
            <dt>Active positions</dt><dd>{info.activePositions}</dd>
          </dl>
        ),
        transfer: (
          <dl>
            <dt>USDC transfer</dt>
            <dd className="mono">{transferSig ? <a href={explorer("tx", transferSig)} target="_blank" rel="noreferrer">{transferSig.slice(0, 10)}...</a> : voided ? "Shown after the refund" : "Shown after the claim"}</dd>
          </dl>
        ),
      }} />
    </section>
  );
}
