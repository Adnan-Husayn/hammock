import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { DETENTS, FALL_MAX, fmtPct, lossLine, snapFall, stepFall, uncoveredLine, type LinePoint } from "../lib/line";
import { fmtUsd, netLoss } from "../lib/program";

const W = 640, H = 300, L = 64, R = 16, T = 18, B = 40;

/**
 * Net loss against Monday's fall, 0% to 8%. Loss is drawn downward, so the uncovered line keeps falling.
 * The viewBox is fixed and scaled uniformly: the line never stretches.
 */
export function PayoffChart({ holding, contracts, premiumTotal, fall, onFall, label }: {
  holding: number; contracts: number; premiumTotal: number; fall: number; onFall?: (f: number) => void; label: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const covered = lossLine(holding, contracts, premiumTotal);
  const bare = uncoveredLine(holding);
  const all = [...covered, ...bare].map((p) => p.loss);
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const x = (f: number) => L + (f / FALL_MAX) * (W - L - R);
  const y = (loss: number) => T + ((loss - lo) / (hi - lo)) * (H - T - B);
  const path = (pts: LinePoint[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.fall).toFixed(2)},${y(p.loss).toFixed(2)}`).join(" ");
  const here = netLoss(holding, fall, contracts, premiumTotal);
  const ticks = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
  const yTicks = [0, hi / 2, hi].map((v) => Math.round(v));

  const fromPointer = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const scale = Math.min(r.width / W, r.height / H) || 1;
    const offsetX = (r.width - W * scale) / 2;
    const vx = (e.clientX - r.left - offsetX) / scale;
    onFall?.(snapFall(((vx - L) / (W - L - R)) * FALL_MAX));
  };
  const onKey = (e: KeyboardEvent) => {
    const next = stepFall(fall, e.key);
    if (next !== fall || ["Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      onFall?.(next);
    }
  };

  return (
    <svg
      ref={svg} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} data-testid="payoff-chart"
      onPointerDown={onFall ? (e) => { (e.target as Element).setPointerCapture?.(e.pointerId); fromPointer(e); } : undefined}
      onPointerMove={onFall ? (e) => { if (e.buttons) fromPointer(e); } : undefined}
    >
      <rect className="band" x={x(DETENTS[0])} y={T} width={x(DETENTS[1]) - x(DETENTS[0])} height={H - T - B} />
      <text className="band-label" x={(x(DETENTS[0]) + x(DETENTS[1])) / 2} y={T + 14} textAnchor="middle">1% to 5% band</text>
      {yTicks.map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="axis" x={L - 8} y={y(v) + 4} textAnchor="end">{fmtUsd(v).replace(".00", "")}</text>
        </g>
      ))}
      {ticks.map((f) => <text key={f} className="axis" x={x(f)} y={H - B + 18} textAnchor="middle">{`${Math.round(f * 100)}%`}</text>)}
      <text className="axis" x={W - R} y={H - 6} textAnchor="end">Monday fall from the Friday mark</text>
      <path className="uncovered" d={path(bare)} data-testid="uncovered-line" />
      <path className="covered" d={path(covered)} data-testid="covered-line" />
      <line className="marker-rule" x1={x(fall)} x2={x(fall)} y1={T} y2={H - B} />
      {onFall ? (
        <g
          className="handle" tabIndex={0} role="slider" aria-label="Monday fall"
          aria-valuemin={0} aria-valuemax={8} aria-valuenow={Number((fall * 100).toFixed(2))}
          aria-valuetext={`${fmtPct(fall)} fall, net loss ${fmtUsd(here)}`} onKeyDown={onKey}
        >
          <circle r={22} cx={x(fall)} cy={y(here)} className="hit" />
          <circle r={7} cx={x(fall)} cy={y(here)} className="dot" />
        </g>
      ) : <circle r={6} cx={x(fall)} cy={y(here)} className="dot" />}
    </svg>
  );
}
