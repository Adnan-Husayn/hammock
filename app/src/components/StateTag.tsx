export type Certainty = "estimate" | "observed" | "final";

const TITLE: Record<Certainty, string> = {
  estimate: "Estimate: may change, does not decide the payout",
  observed: "Observed: a signed mark is in, not yet final",
  final: "Final: fixed on chain",
};

/** Estimate, observed and final each look different: dashed, outlined, filled. */
export function StateTag({ kind }: { kind: Certainty }) {
  return <span className={`tag tag-${kind}`} title={TITLE[kind]}>{kind}</span>;
}
