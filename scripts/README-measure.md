# Mark-time logger

`measure-marks.mjs` streams Pyth Pro NVDA (feed 1314, fixed_rate@200ms) for 60 s around
two daily marks and appends one row per leg to `data/marks.csv`.

- close leg: T = 15:59:30 ET, open leg: T = 09:31:30 ET. Capture runs T-30 s to T+30 s.
- Run by hand: `node scripts/measure-marks.mjs [open|close]`. With no leg it picks the one due within
  10 minutes and exits on weekends. `--now` is a test mode (T = now + 30 s, writes `data/test-marks.csv`).
- Token: `PYTH_PRO_TOKEN` in `.env` (gitignored) or the environment.
- Columns: date,leg,target_utc,updates,session,conf_bps_p50,conf_bps_p95,conf_bps_max,publishers_min,publishers_p50,fresh_share.
  fresh = feedUpdateTimestamp equals the update timestamp; conf_bps = confidence / price * 1e4.

## Schedule (Mac on IST, no daylight saving)

After US clocks go back on 1 Nov 2026 (EST = UTC-5): 09:31:30 ET = 20:01:30 IST, 15:59:30 ET = 02:29:30 IST next day.
Until then (EDT) the marks sit one hour earlier in IST, so the runs start late and the script exits with
"no leg due"; the 1 Nov change fixes that. The job starts at 20:00 IST Mon-Fri (open leg) and 02:28 IST Tue-Sat
(close leg, which falls after midnight in India). The script computes T in America/New_York itself,
so a wrong start time only wastes a run.

Install:

    cp scripts/com.monday-gap-cover.measure.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.monday-gap-cover.measure.plist

Logs: `logs/measure.log`. The Mac must be awake at the start times.
