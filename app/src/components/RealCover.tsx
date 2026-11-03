import { useCallback, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps, ArchiveUpdate } from "../lib/api";
import { DOLLARS_PER_CONTRACT, price, usdc, type MarketInfo, type PositionInfo } from "../lib/program";
import type { CoverRecord, CoverStatus } from "../lib/cover";
import { CoverCard } from "./CoverCard";
import { ProofScreen } from "./ProofScreen";
import { Settle } from "./Settle";

/** The card status for a position on chain. The market state and the position decide it, nothing else. */
export function realStatus(info: MarketInfo, position: PositionInfo): CoverStatus {
  if (info.state === "Voided") return "Voided";
  if (info.state === "MondayFinal") {
    if (info.payoutPerContract === 0n) return "Expired, no payout";
    return position.closed ? "Claimed" : "Monday mark final";
  }
  return "Cover active";
}

export function realRecord(market: PublicKey, symbol: string, info: MarketInfo, position: PositionInfo, verified: boolean): CoverRecord {
  return {
    id: market.toBase58(),
    kind: "real",
    symbol,
    holding: position.contracts * DOLLARS_PER_CONTRACT,
    contracts: position.contracts,
    premium: usdc(position.premiumPaid),
    fridayPrice: info.friday ? price(info.friday.price) : null,
    fridayAt: info.friday ? Number(info.friday.feedTsUs / 1000n) : Number(info.fridayTargetUs / 1000n),
    mondayAt: info.monday ? Number(info.monday.feedTsUs / 1000n) : Number(info.mondayTargetUs / 1000n),
    mondayPrice: info.monday ? price(info.monday.price) : null,
    status: realStatus(info, position),
    payoutPerContract: info.state === "MondayFinal" ? usdc(info.payoutPerContract) : undefined,
    verified,
  };
}

/**
 * A cover bought on devnet, read from chain. Shows nothing until the wallet holds a position in this market.
 * Claim and refund happen on the card; the receipt sits behind "See the proof".
 */
export function RealCover({ deps, market, info, symbol, nonce = 0, buyBy, onRecord, onSettled }: {
  deps: AppDeps; market: PublicKey; info: MarketInfo; symbol: string; nonce?: number; buyBy?: string;
  onRecord?: (c: CoverRecord | null) => void; onSettled?: (sig: string) => void;
}) {
  const [position, setPosition] = useState<PositionInfo | null>(null);
  const [archive, setArchive] = useState<{ fri: ArchiveUpdate[]; mon: ArchiveUpdate[] }>({ fri: [], mon: [] });
  const [weekend, setWeekend] = useState<number | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const w = deps.wallet;
  const final = info.state === "MondayFinal";

  useEffect(() => {
    if (!w) return setPosition(null);
    let live = true;
    deps.chain.readPosition(market, w.publicKey).then((p) => live && setPosition(p)).catch(() => {});
    return () => { live = false; };
  }, [deps, market, w, nonce, reads, info]);

  useEffect(() => {
    if (!final) return;
    let live = true;
    Promise.all([deps.service.archive(market.toBase58(), "friday"), deps.service.archive(market.toBase58(), "monday")])
      .then(([fri, mon]) => live && setArchive({ fri, mon })).catch(() => {});
    return () => { live = false; };
  }, [deps, market, final]);

  useEffect(() => {
    if (info.state !== "FridayFinal" || info.sandbox) return;
    let live = true;
    deps.chain.referencePrice(symbol).then((p) => live && setWeekend(p)).catch(() => {});
    return () => { live = false; };
  }, [deps, symbol, info.state, info.sandbox]);

  const has = (list: ArchiveUpdate[], ts?: bigint) => ts !== undefined && list.some((u) => u.feedTsUs === ts.toString());
  const verified = final && !info.sandbox && has(archive.fri, info.friday?.feedTsUs) && has(archive.mon, info.monday?.feedTsUs);
  const record = position && position.contracts > 0 ? realRecord(market, symbol, info, position, verified) : null;
  const key = record ? `${record.id}:${record.status}:${record.contracts}:${verified}` : "";
  useEffect(() => { onRecord?.(record); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSent = useCallback((s: string) => { setSig(s); setReads((n) => n + 1); onSettled?.(s); }, [onSettled]);
  if (!record) return null;
  const needsAction = record.status === "Monday mark final" || (record.status === "Voided" && !position!.closed);
  return (
    <CoverCard c={record} holdingLabel="Your holding" buyBy={buyBy} weekendPrice={weekend}
      actions={needsAction ? <Settle deps={deps} market={market} info={info} onSent={onSent} /> : undefined}
      proof={<ProofScreen deps={deps} market={market} info={info} transferSig={sig} contracts={record.contracts} />} />
  );
}
