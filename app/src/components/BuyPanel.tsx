import { useCallback, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { AppDeps, QuoteJson } from "../lib/api";
import { buildBuyTx, fmtUsd, usdc, type MarketInfo } from "../lib/program";
import { signAndSend } from "../lib/send";

export const QUOTE_REFRESH_MS = 60_000;

export function BuyPanel({ deps, market, info, contracts, onBought, onQuote }: {
  deps: AppDeps; market: PublicKey; info: MarketInfo; contracts: number; onBought?: () => void; onQuote?: (premiumPerContract: number) => void;
}) {
  const [quote, setQuote] = useState<QuoteJson | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wallet = deps.wallet;

  const refresh = useCallback(async () => {
    if (!wallet || contracts <= 0) return setQuote(null);
    try {
      const [q, b] = await Promise.all([
        deps.service.quote(market.toBase58(), wallet.publicKey.toBase58(), contracts),
        deps.chain.usdcBalance(info.usdcMint, wallet.publicKey, info.tokenProgram),
      ]);
      setQuote(q);
      setBalance(b);
      setError(null);
      onQuote?.(usdc(BigInt(q.premiumPerContract)));
    } catch (e) {
      setQuote(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [deps, wallet, market, info, contracts, onQuote]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, QUOTE_REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const short = quote !== null && balance !== null && balance < BigInt(quote.totalPremium);

  const buy = async () => {
    if (!wallet || !quote || short || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signAndSend(deps, (feePayer, blockhash) =>
        buildBuyTx({ programId: deps.programId, market, info, user: wallet.publicKey, feePayer, blockhash }, quote.ed25519Data), info.sandbox);
      onBought?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) return <section className="card"><h2>Buy cover</h2><p>Connect a wallet to get a quote.</p></section>;
  return (
    <section className="card">
      <h2>Buy cover</h2>
      {quote && (
        <dl>
          <dt>Premium per contract</dt><dd>{usdc(BigInt(quote.premiumPerContract)).toFixed(6)} USDC</dd>
          <dt>Total premium</dt><dd>{fmtUsd(usdc(BigInt(quote.totalPremium)))}</dd>
          <dt>Quote expires</dt><dd>{new Date(quote.expiry * 1000).toLocaleTimeString()}</dd>
        </dl>
      )}
      {quote && (
        <p className="note">Premium = base {quote.inputs.base.toFixed(4)} + uncertainty {quote.inputs.uncertainty.toFixed(4)} + utilisation {quote.inputs.utilisation.toFixed(4)} + reserve {quote.inputs.reserve.toFixed(4)}. Move since the Friday mark: {quote.inputs.m.toFixed(4)}. Sold {quote.inputs.sold} of {quote.inputs.max}. The program checks the dealer's signature, not the fairness of this price.</p>
      )}
      {short && <p className="warn">Not enough USDC</p>}
      {error && <p className="warn">{error}</p>}
      <button className="primary" disabled={!quote || short || busy} onClick={buy}>{busy ? "Waiting for wallet" : `Buy ${contracts} contracts`}</button>
    </section>
  );
}
