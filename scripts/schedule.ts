import { readFileSync } from "node:fs";

// Pyth Lazer schedule string for feed 1314 (NVDA), saved in fixtures/pyth/symbols-1314.json:
//   "<tz>;<Mon>,<Tue>,<Wed>,<Thu>,<Fri>,<Sat>,<Sun>;<MMDD>/<hours>,..."
// hours is "HHMM-HHMM" or "C" (closed). Overrides carry no year and recur by MMDD.
const FIXTURE = new URL("../fixtures/pyth/symbols-1314.json", import.meta.url);

export interface Targets {
  fridayTargetUtc: Date;
  mondayTargetUtc: Date;
}

interface Day {
  open: [number, number] | null; // [h, m] or null when closed
  close: [number, number] | null;
}

export function loadSchedule(): string {
  const feeds = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return feeds[0].schedule as string;
}

function parseHours(s: string): Day {
  if (s === "C") return { open: null, close: null };
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new Error(`unsupported hours: ${s}`);
  return { open: [+m[1], +m[2]], close: [+m[3], +m[4]] };
}

function dayInfo(schedule: string, y: number, mo: number, d: number): Day {
  const [tz, weekly, overrides = ""] = schedule.split(";");
  if (tz !== "America/New_York") throw new Error(`unsupported timezone: ${tz}`);
  const key = String(mo).padStart(2, "0") + String(d).padStart(2, "0");
  for (const o of overrides.split(",")) {
    const [k, v] = o.split("/");
    if (k === key) return parseHours(v);
  }
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
  return parseHours(weekly.split(",")[(dow + 6) % 7]);
}

// Wall-clock time in America/New_York to a UTC instant (DST-safe via Intl).
export function etToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  });
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, +x.value]));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    utc += wall - shown;
  }
  return new Date(utc);
}

/**
 * dateEt is a YYYY-MM-DD calendar date in America/New_York.
 *  - Saturday or Sunday: throws (no trading week to anchor on).
 *  - Monday to Friday: the date selects that week's Friday and the Monday after it.
 *    If dateEt itself, that Friday or that Monday is closed (full-day holiday), returns "holiday".
 *  - Friday target = scheduled close minus 30 s (15:59:30 ET normally, 12:59:30 ET on early closes).
 *  - Monday target = scheduled open plus 90 s (09:31:30 ET).
 */
export function scheduleTargets(dateEt: string, schedule: string = loadSchedule()): Targets | "holiday" {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateEt);
  if (!m) throw new Error(`bad date: ${dateEt}`);
  const base = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dow = base.getUTCDay();
  if (dow === 0 || dow === 6) throw new Error(`${dateEt} is a weekend`);
  const at = (offsetDays: number) => {
    const t = new Date(base.getTime() + offsetDays * 86_400_000);
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] as const;
  };
  const fri = at(5 - dow);
  const mon = at(8 - dow);
  const dDate = dayInfo(schedule, +m[1], +m[2], +m[3]);
  const dFri = dayInfo(schedule, ...fri);
  const dMon = dayInfo(schedule, ...mon);
  if (!dDate.open || !dFri.close || !dMon.open) return "holiday";
  return {
    fridayTargetUtc: etToUtc(...fri, dFri.close[0], dFri.close[1], -30),
    mondayTargetUtc: etToUtc(...mon, dMon.open[0], dMon.open[1], 90),
  };
}
