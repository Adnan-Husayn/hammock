import { describe, expect, it } from "vitest";
import { scheduleTargets } from "../scripts/schedule";

const iso = (r: ReturnType<typeof scheduleTargets>) =>
  r === "holiday" ? r : [r.fridayTargetUtc.toISOString(), r.mondayTargetUtc.toISOString()];

describe("scheduleTargets", () => {
  it("normal Friday 20 Nov: 15:59:30 ET and Monday 09:31:30 ET", () => {
    expect(iso(scheduleTargets("2026-11-20"))).toEqual(["2026-11-20T20:59:30.000Z", "2026-11-23T14:31:30.000Z"]);
  });
  it("Friday 27 Nov early close 12:59:30 ET", () => {
    const r = scheduleTargets("2026-11-27");
    expect(iso(r)).toEqual(["2026-11-27T17:59:30.000Z", "2026-11-30T14:31:30.000Z"]);
  });
  it("Thanksgiving 26 Nov is a holiday", () => {
    expect(scheduleTargets("2026-11-26")).toBe("holiday");
  });
  it("Monday holiday after the Friday returns holiday", () => {
    // 2027-01-15 Friday; Monday 2027-01-18 is closed (0118/C)
    expect(scheduleTargets("2027-01-15")).toBe("holiday");
  });
  it("rejects weekends", () => {
    expect(() => scheduleTargets("2026-11-21")).toThrow();
  });
});
