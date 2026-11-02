// Builds service/data/<sym>-gaps.csv: the last 104 weekends of one stock as Friday regular close to Monday regular open,
// from free daily bars (Yahoo Finance chart API, no key). This is a proxy for the settlement marks, not the exact
// 15:59:30 ET Friday and 09:31:30 ET Monday prices the program settles on. Holiday weekends (no Friday or no Monday
// session) are skipped. gap = (friday_close - monday_open) / friday_close, positive = fall.
// Usage: node scripts/build-gaps.mjs [SYMBOL ...] [--out out.csv]   (default NVDA; --out only with one symbol)
//   node scripts/build-gaps.mjs NVDA TSLA SPY AAPL
import { writeFileSync } from "node:fs";

const WEEKENDS = 104;
const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outArg = oi >= 0 ? args.splice(oi, 2)[1] : undefined;
const symbols = args.length ? args.map((s) => s.toUpperCase()) : ["NVDA"];
if (outArg && symbols.length !== 1) throw new Error("--out takes one symbol");
for (const s of symbols) if (!/^[A-Z]{1,6}$/.test(s)) throw new Error(`bad symbol ${s}`);

for (const sym of symbols) {
  const out = outArg ?? new URL(`../service/data/${sym.toLowerCase()}-gaps.csv`, import.meta.url).pathname;
  await build(sym, out);
}

async function build(SYM, OUT) {
const URL_ = `https://query1.finance.yahoo.com/v8/finance/chart/${SYM}?range=5y&interval=1d`;
const res = await fetch(URL_, { headers: { "User-Agent": "Mozilla/5.0" } });
if (!res.ok) throw new Error(`${SYM} daily data HTTP ${res.status}`);
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
if (last.length < WEEKENDS) throw new Error(`${SYM}: only ${last.length} weekends found`);

const notes = [
  `# ${SYM} weekend gaps, last 104 weekends.`,
  "# PROXY: Friday regular close to Monday regular open from free daily bars",
  "# (Yahoo Finance), not the 15:59:30 ET Friday and 09:31:30 ET Monday marks used for settlement.",
  "# gap = (friday_close - monday_open) / friday_close, positive = fall. Holiday weekends skipped.",
  `# Built ${new Date().toISOString().slice(0, 10)} by scripts/build-gaps.mjs.`,
];
writeFileSync(OUT, [...notes, "friday,monday,friday_close,monday_open,gap", ...last.map((r) => r.join(","))].join("\n") + "\n");
console.log(`${SYM}: wrote ${last.length} weekends to ${OUT} (${last[0][0]} .. ${last.at(-1)[0]})`);
}
