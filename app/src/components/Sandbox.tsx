import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { AppDeps } from "../lib/api";
import { fmtUsd, price, type MarketInfo } from "../lib/program";
import { BuyPanel } from "./BuyPanel";
import { ProofScreen } from "./ProofScreen";
import { Settle } from "./Settle";

export function Sandbox({ deps }: { deps: AppDeps }) {
  const [market, setMarket] = useState<PublicKey | null>(null);
  const [info, setInfo] = useState<MarketInfo | null>(null);
  const [bought, setBought] = useState(false);
  const [rung, setRung] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try { await f(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const [faucetCount, setFaucetCount] = useState(0);
  const start = (mode: "gap" | "multiplierVoid") => run(async () => {
    const r = await deps.service.startSandbox(mode);
    const m = new PublicKey(r.market);
    setBought(false); setRung(false);
    setMarket(m);
    setInfo(await deps.chain.readMarket(m));
    setNote(`Friday afternoon mark set at ${fmtUsd(price(BigInt(r.fridayPrice)))}.`);
  });
  const faucet = () => run(async () => {
    if (!deps.wallet) throw new Error("Connect a wallet first");
    await deps.service.faucet(deps.wallet.publicKey.toBase58());
    setNote("Demo USDC and NVDAx (test) sent to your wallet.");
    setFaucetCount((n) => n + 1);
  });
  const bell = () => run(async () => {
    const r = await deps.service.bell(market!.toBase58());
    setRung(true);
    setInfo(await deps.chain.readMarket(market!));
    setNote(r.fallBps === null ? "The share multiplier changed, so this market is void. Refund your premium below." : `Monday morning mark: ${fmtUsd(price(BigInt(r.mondayPrice)))}, a fall of ${(r.fallBps / 100).toFixed(2)}%.`);
  });
  const onBought = useCallback(() => setBought(true), []);

  return (
    <section className="card" id="sandbox">
      <h2>Sandbox</h2>
      <p>Devnet only, with demo tokens. Fees are paid for you. Run a whole weekend in seconds.</p>
      <div className="row">
        <button disabled={busy} onClick={faucet}>Get demo tokens</button>
        <button disabled={busy} onClick={() => start("gap")}>Start in gap mode</button>
        <button disabled={busy} onClick={() => start("multiplierVoid")}>Start in multiplier-void mode</button>
      </div>
      {note && <p className="note">{note}</p>}
      {market && info && !rung && <BuyPanel deps={deps} market={market} info={info} contracts={200} onBought={onBought} balanceNonce={faucetCount} />}
      {bought && !rung && <button className="primary" disabled={busy} onClick={bell}>Ring the Monday bell</button>}
      {market && info && rung && <><Settle deps={deps} market={market} info={info} /><ProofScreen deps={deps} market={market} info={info} /></>}
    </section>
  );
}
