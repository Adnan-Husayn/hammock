// Builds service/data/nvda-gaps.csv: the last 104 NVDA weekends as Friday regular close to Monday regular open,
// from free daily bars (Yahoo Finance chart API, no key). This is a proxy for the settlement marks, not the exact
// 15:59:30 ET Friday and 09:31:30 ET Monday prices the program settles on. Holiday weekends (no Friday or no Monday
// session) are skipped. gap = (friday_close - monday_open) / friday_close, positive = fall.
// Usage: node scripts/build-gaps.mjs [out.csv]
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? new URL("../service/data/nvda-gaps.csv", import.meta.url).pathname;
const URL_ = "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5y&interval=1d";
const WEEKENDS = 104;

const res = await fetch(URL_, { headers: { "User-Agent": "Mozilla/5.0" } });
if (!res.ok) throw new Error(`daily data HTTP ${res.status}`);
const r = (await res.json()).chart.result[0];
const offset = r.meta.gmtoffset ?? 0; // exchange offset; dates below are New York calendar days
const q = r.indicators.quote[0];
const bars = r.timestamp
  .map((t, i) => ({ date: new Date((t + offset) * 1000).toISOString().slice(0, 10), open: q.open[i], close: q.close[i] }))
  .filter((b) => b.open != null && b.close != null);

const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const plusDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const rows = [];
for (let i = 0; i + 1 < bars.length; i++) {
  const f = bars[i], m = bars[i + 1];
  if (dow(f.date) !== 5 || m.date !== plusDays(f.date, 3)) continue;
  rows.push([f.date, m.date, f.close.toFixed(4), m.open.toFixed(4), ((f.close - m.open) / f.close).toFixed(6)]);
}
const last = rows.slice(-WEEKENDS);
if (last.length < WEEKENDS) throw new Error(`only ${last.length} weekends found`);

const notes = [
  "# NVDA weekend gaps, last 104 weekends. PROXY: Friday regular close to Monday regular open from free daily bars",
  "# (Yahoo Finance), not the 15:59:30 ET Friday and 09:31:30 ET Monday marks used for settlement.",
  "# gap = (friday_close - monday_open) / friday_close, positive = fall. Holiday weekends skipped.",
  `# Built ${new Date().toISOString().slice(0, 10)} by scripts/build-gaps.mjs.`,
];
writeFileSync(OUT, [...notes, "friday,monday,friday_close,monday_open,gap", ...last.map((r) => r.join(","))].join("\n") + "\n");
console.log(`wrote ${last.length} weekends to ${OUT} (${last[0][0]} .. ${last.at(-1)[0]})`);
