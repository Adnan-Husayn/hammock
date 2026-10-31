// Logs Pyth Pro quality for the candidate stocks around the two daily US mark times.
// Usage: node scripts/measure-marks.mjs [close|open] [--now]
//   close = 15:59:30 ET, open = 09:31:30 ET. No leg: pick the next one within ~10 minutes.
//   --now: test mode, T = now + 30 s, writes to data/test-marks.csv.
import WebSocket from "ws";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = { 1314: "NVDA", 1435: "TSLA", 1398: "SPY", 922: "AAPL", 1163: "GOOGL", 1292: "MSFT", 1272: "META", 1363: "QQQ", 954: "AMZN" };
const HEADER = "date,symbol,feed_id,leg,target_utc,updates,session,conf_bps_p50,conf_bps_p95,conf_bps_max,publishers_min,publishers_p50,fresh_share";
const LEGS = { open: [9, 31, 30], close: [15, 59, 30] };
const ENDPOINTS = [0, 1, 2].map((i) => `wss://pyth-lazer-${i}.dourolabs.app/v1/stream`);
const args = process.argv.slice(2);
const TEST = args.includes("--now");
const legArg = args.find((a) => a in LEGS);

function token() {
  if (process.env.PYTH_PRO_TOKEN) return process.env.PYTH_PRO_TOKEN;
  const m = readFileSync(join(ROOT, ".env"), "utf8").match(/^\s*(?:export\s+)?PYTH_PRO_TOKEN\s*=\s*["']?([^"'\r\n]+)/m);
  if (!m) throw new Error("PYTH_PRO_TOKEN missing");
  return m[1].trim();
}

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
function etParts(ms) {
  const o = {}; for (const p of etFmt.formatToParts(new Date(ms))) o[p.type] = p.value; return o;
}
// UTC ms of a wall-clock time in New York on the given y-m-d.
function etToUtc(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (const off of [4, 5]) { // EDT, EST
    const t = guess + off * 3600e3, p = etParts(t);
    if (+p.hour === h && +p.minute === mi && +p.day === d) return t;
  }
  throw new Error("cannot resolve ET time");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : null;

async function capture(startMs, endMs) {
  const rows = [], errs = [];
  for (const url of ENDPOINTS) {
    if (Date.now() >= endMs) break;
    await new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token()}` } });
      let done = false, opened = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(); };
      const timer = setTimeout(finish, Math.max(0, endMs - Date.now()) + 2000);
      ws.on("open", () => { opened = true; ws.send(JSON.stringify({ type: "subscribe", subscriptionId: 1, priceFeedIds: Object.keys(FEEDS).map(Number),
        properties: ["price", "exponent", "confidence", "publisherCount", "marketSession", "feedUpdateTimestamp"],
        formats: [], deliveryFormat: "json", jsonBinaryEncoding: "hex", parsed: true, channel: "fixed_rate@200ms" })); });
      ws.on("message", (b) => {
        const m = JSON.parse(String(b));
        if (m.type !== "streamUpdated") { if (m.type !== "subscribed") errs.push(m.type ?? "msg"); return; }
        const ts = BigInt(m.parsed.timestampUs);
        if (Number(ts / 1000n) > endMs) return finish();
        for (const f of m.parsed.priceFeeds) rows.push({ feed: f.priceFeedId, ts, fu: f.feedUpdateTimestamp != null ? BigInt(f.feedUpdateTimestamp) : null,
          price: Number(f.price), conf: Number(f.confidence), pubs: f.publisherCount, s: f.marketSession });
      });
      ws.on("error", (e) => errs.push(e.message));
      ws.on("close", finish);
      if (!opened) setTimeout(() => { if (!opened) finish(); }, 8000);
    });
    if (rows.length) break; // fell through only if this endpoint failed to deliver
  }
  return { rows, errs };
}

async function main() {
  const now = Date.now();
  let leg, T;
  if (TEST) { leg = legArg ?? "test"; T = now + 30e3; }
  else {
    const p = etParts(now);
    if (p.weekday === "Sat" || p.weekday === "Sun") { console.log(`not a US weekday (${p.weekday}); exiting`); return; }
    const cands = Object.entries(LEGS).map(([name, hms]) => [name, etToUtc(+p.year, +p.month, +p.day, ...hms)]);
    const pick = legArg ? cands.find((c) => c[0] === legArg)
      : cands.filter(([, t]) => t + 30e3 > now && t - 30e3 - now <= 10 * 60e3).sort((a, b) => a[1] - b[1])[0];
    if (!pick || pick[1] + 30e3 <= now) { console.log("no leg due within 10 minutes; exiting"); return; }
    [leg, T] = pick;
    if (T - 30e3 - now > 10 * 60e3) { console.log("leg more than 10 minutes away; exiting"); return; }
  }
  const startMs = T - 30e3, endMs = T + 30e3;
  console.log(`leg=${leg} T=${new Date(T).toISOString()} capture ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`);
  if (startMs > Date.now()) await sleep(startMs - Date.now());

  const { rows: all, errs } = await capture(startMs, endMs);
  const f = (x) => x == null ? "" : x.toFixed(2);
  const p = etParts(T);
  const file = join(ROOT, "data", TEST ? "test-marks.csv" : "marks.csv");
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) appendFileSync(file, HEADER + "\n");
  for (const [id, symbol] of Object.entries(FEEDS)) {
    const rows = all.filter((r) => r.feed === Number(id));
    const bps = rows.filter((r) => r.price && r.conf).map((r) => (r.conf / r.price) * 1e4);
    const sessions = [...new Set(rows.map((r) => r.s))].join("|");
    const fresh = rows.length ? rows.filter((r) => r.fu === r.ts).length / rows.length : null;
    const line = [`${p.year}-${p.month}-${p.day}`, symbol, id, leg, new Date(T).toISOString(), rows.length, sessions,
      f(q(bps, .5)), f(q(bps, .95)), f(q(bps, 1)), q(rows.map((r) => r.pubs), 0) ?? "", q(rows.map((r) => r.pubs), .5) ?? "",
      fresh == null ? "" : fresh.toFixed(3)].join(",");
    appendFileSync(file, line + "\n");
    console.log(line);
  }
  if (errs.length) console.log("notes:", [...new Set(errs)].slice(0, 3).join("; "));
}
main().catch((e) => { console.error(String(e.message ?? e).replace(/Bearer\s+\S+/g, "Bearer ***")); process.exit(1); });
