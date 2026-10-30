import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import { buildClaimTx, buildRefundTx, fmtUsd, usdc, type MarketInfo, type PositionInfo } from "../lib/program";
import { signAndSend } from "../lib/send";

/** Claim after the Monday morning mark, or refund the premium on a voided market. */
export function Settle({ deps, market, info }: { deps: AppDeps; market: PublicKey; info: MarketInfo }) {
  const [position, setPosition] = useState<PositionInfo | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const w = deps.wallet;
  const load = () => { if (w) deps.chain.readPosition(market, w.publicKey).then(setPosition).catch(() => {}); };
  useEffect(load, [deps, market]);
  if (!w || !position || position.closed) return status ? <p>{status}</p> : null;
  const voided = info.state === "Voided";
  const amount = voided ? usdc(position.premiumPaid) : usdc(info.payoutPerContract) * position.contracts;
  const act = async () => {
    setBusy(true);
    try {
      await signAndSend(deps, (feePayer, blockhash) => {
        const c = { programId: deps.programId, market, info, user: w.publicKey, feePayer, blockhash };
        return voided ? buildRefundTx(c) : buildClaimTx(c);
      }, info.sandbox);
      setStatus(`${fmtUsd(amount)} sent to your wallet.`);
      load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {status && <p>{status}</p>}
      <button className="primary" disabled={busy} onClick={act}>{voided ? `Refund ${fmtUsd(amount)}` : `Claim ${fmtUsd(amount)}`}</button>
    </div>
  );
}
