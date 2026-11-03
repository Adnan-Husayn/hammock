import { useEffect, useState } from "react";
import type { AppDeps } from "../lib/api";
import { fmtUsd, price, type MarketInfo } from "../lib/program";
import { tokenName } from "../lib/markets";
import { StateTag, type Certainty } from "./StateTag";

/** Two tracks, never merged: the Pyth marks decide the payout; the weekend token price is only an estimate. */
export function PriceTracks({ deps, info, symbol }: { deps: AppDeps; info: MarketInfo; symbol: string }) {
  const [ref, setRef] = useState<number | null>(null);
  const settled = info.state === "MondayFinal" || info.state === "Voided";
  useEffect(() => {
    if (settled) return;
    let live = true;
    deps.chain.referencePrice(symbol).then((p) => live && setRef(p)).catch(() => live && setRef(null));
    return () => { live = false; };
  }, [deps, symbol, settled]);
  const fridayKind: Certainty = info.state === "Created" ? "observed" : "final";
  const mondayKind: Certainty = info.state === "MondayFinal" ? "final" : "observed";
  return (
    <div className="tracks">
      <div className="track track-pyth">
        <h3>Pyth marks <span className="note">decide the payout</span></h3>
        <dl>
          <dt>Friday afternoon mark {info.friday && <StateTag kind={fridayKind} />}</dt>
          <dd>{info.friday ? fmtUsd(price(info.friday.price)) : "Not yet"}</dd>
          <dt>Monday morning mark {info.monday && <StateTag kind={mondayKind} />}</dt>
          <dd>{info.monday ? fmtUsd(price(info.monday.price)) : "Not yet"}</dd>
        </dl>
      </div>
      {!settled && (
        <div className="track track-token">
          <h3>Weekend {tokenName(symbol)} price <span className="note">does not decide the payout</span></h3>
          <dl>
            <dt>Last trade <StateTag kind="estimate" /></dt>
            <dd>{ref === null ? "Not available" : fmtUsd(ref)}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
