import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import { fmtUsd, payoutPerContract, price, type MarketInfo, type PositionInfo } from "../lib/program";
import { stockByFeed, tokenName } from "../lib/markets";

export function LockedView({ deps, market, info }: { deps: AppDeps; market: PublicKey; info: MarketInfo }) {
  const symbol = stockByFeed(info.feedId)?.symbol ?? null;
  const [ref, setRef] = useState<number | null>(null);
  const [position, setPosition] = useState<PositionInfo | null>(null);
  useEffect(() => {
    if (symbol) deps.chain.referencePrice(symbol).then(setRef).catch(() => setRef(null));
    if (deps.wallet) deps.chain.readPosition(market, deps.wallet.publicKey).then(setPosition).catch(() => {});
  }, [deps, market, symbol]);
  const friday = info.friday ? price(info.friday.price) : null;
  const per = ref !== null && friday ? payoutPerContract((friday - ref) / friday) : null;
  return (
    <section className="card">
      <h2>Your cover</h2>
      <p>Active contracts: {position && !position.closed ? position.contracts : 0}</p>
      <p>{per === null ? "No estimate available right now." : `Estimate from the live ${tokenName(symbol ?? "")} price, not a final figure: ${fmtUsd(per)} per contract${position ? `, ${fmtUsd(per * position.contracts)} in all` : ""}.`}</p>
    </section>
  );
}
