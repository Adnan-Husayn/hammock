import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DETENTS, FALL_MAX, fmtPct, lossLine, signedUsd, snapFall, stepFall, uncoveredLine, type LinePoint } from "../lib/line";
import { fmtUsd, netLoss } from "../lib/program";

const R = 20, T = 24, B = 64;
/** Phone x-axis keeps the band edges. */
export const PHONE_TICKS = [0, 0.01, 0.03, 0.05, 0.08];

/**
 * Net loss against Monday's fall, 0% to 8%. Loss is drawn downward, so the uncovered line keeps falling.
 * The viewBox follows the drawn width one to one, so text stays at its real size and the line never stretches.
 */
export function PayoffChart({ holding, contracts, premiumTotal, fall, onFall, label }: {
  holding: number; contracts: number; premiumTotal: number; fall: number; onFall?: (f: number) => void; label: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(920);
  const [room, setRoom] = useState(460); // height left on the first screen below the chart's top
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setRoom(Math.round(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 12));
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setW(w); fit(); });
    ro.observe(el);
    window.addEventListener("resize", fit);
    document.fonts?.ready.then(fit).catch(() => {});
    const t = window.setTimeout(fit, 300);
    return () => { ro.disconnect(); window.clearTimeout(t); window.removeEventListener("resize", fit); };
  }, []);
  const phone = W < 560;
  // Desktop: as tall as the first screen allows, so the whole chart fits without scrolling.
  const H = phone ? 380 : Math.max(260, Math.min(460, room));
  const L = phone ? 58 : 76;
  const covered = lossLine(holding, contracts, premiumTotal);
  const bare = uncoveredLine(holding);
  const all = [...covered, ...bare].map((p) => p.loss);
  const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
  const x = (f: number) => L + (f / FALL_MAX) * (W - L - R);
  const y = (loss: number) => T + ((loss - lo) / (hi - lo)) * (H - T - B);
  const path = (pts: LinePoint[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.fall).toFixed(2)},${y(p.loss).toFixed(2)}`).join(" ");
  const here = netLoss(holding, fall, contracts, premiumTotal);
  const ticks = phone ? PHONE_TICKS : [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
  const yTicks = [0, hi / 2, hi].map((v) => Math.round(v));
  const [l1, l5] = [covered[1].loss, covered[2].loss];
  const flat = contracts > 0 && Math.abs(l5 - l1) < 0.01;

  const fromPointer = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const scale = r.width / W || 1;
    const vx = (e.clientX - r.left) / scale;
    onFall?.(snapFall(((vx - L) / (W - L - R)) * FALL_MAX));
  };
  const onKey = (e: KeyboardEvent) => {
    const next = stepFall(fall, e.key);
    if (next !== fall || ["Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      onFall?.(next);
    }
  };
  const mid = (x(DETENTS[0]) + x(DETENTS[1])) / 2;

  return (
    <svg
      ref={svg} className="chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }} role="img" aria-label={label} data-testid="payoff-chart"
      onPointerDown={onFall ? (e) => { (e.target as Element).setPointerCapture?.(e.pointerId); fromPointer(e); } : undefined}
      onPointerMove={onFall ? (e) => { if (e.buttons) fromPointer(e); } : undefined}
    >
      <rect className="band" x={x(DETENTS[0])} y={T} width={x(DETENTS[1]) - x(DETENTS[0])} height={H - T - B} />
      {DETENTS.map((d) => <line key={d} className="band-rule" x1={x(d)} x2={x(d)} y1={T} y2={H - B} />)}
      <text className="band-label" x={mid} y={H - B - 10} textAnchor="middle">1% to 5% band</text>
      {!phone && <text className="detent-label" x={x(DETENTS[0]) + 6} y={H - B - 10}>Payout starts at 1%</text>}
      {!phone && <text className="detent-label" x={x(DETENTS[1]) - 6} y={H - B - 10} textAnchor="end">Full payout at 5%</text>}
      {yTicks.map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="axis" x={L - 10} y={y(v) + 5} textAnchor="end">{signedUsd(-v).replace(".00", "")}</text>
        </g>
      ))}
      {ticks.map((f) => <text key={f} className="axis xtick" x={x(f)} y={H - B + 24} textAnchor="middle">{`${Math.round(f * 100)}%`}</text>)}
      <text className="axis axis-title" x={W - R} y={H - 10} textAnchor="end">Monday fall from the Friday mark</text>
      <path className="uncovered" d={path(bare)} data-testid="uncovered-line" />
      <path className="covered" d={path(covered)} data-testid="covered-line" />
      {flat && <text className="flat-label" x={fall < (DETENTS[0] + DETENTS[1]) / 2 ? x(DETENTS[1]) - 6 : x(DETENTS[0]) + 6} y={y(l1) - 22} textAnchor={fall < (DETENTS[0] + DETENTS[1]) / 2 ? "end" : "start"} data-side={fall < (DETENTS[0] + DETENTS[1]) / 2 ? "right" : "left"} data-testid="flat-label">{`flat at ${signedUsd(-l1)}`}</text>}
      <line className="marker-rule" x1={x(fall)} x2={x(fall)} y1={T} y2={H - B} />
      {onFall ? (
        <g
          className="handle" tabIndex={0} role="slider" aria-label="Monday fall"
          aria-valuemin={0} aria-valuemax={8} aria-valuenow={Number((fall * 100).toFixed(2))}
          aria-valuetext={`${fmtPct(fall)} fall, net loss ${fmtUsd(here)}`} onKeyDown={onKey}
        >
          <circle r={28} cx={x(fall)} cy={y(here)} className="hit" />
          <circle r={11} cx={x(fall)} cy={y(here)} className="dot" />
        </g>
      ) : <circle r={10} cx={x(fall)} cy={y(here)} className="dot" />}
    </svg>
  );
}
