import { describe, expect, it } from "vitest";
import { isReportRejection } from "../src/chain.ts";
import { LAZER_PROGRAM_ID } from "../src/config.ts";

const err = (n: string) => [`Program log: AnchorError thrown. Error Code: ${n}. Error Number: 6000.`];

describe("isReportRejection", () => {
  it.each(["WrongFeed", "WrongSession", "CarriedForward", "OutsideWindow", "ZeroPrice", "WrongExponent", "WideConfidence", "TooFewPublishers", "BadPayload"])("%s is final", (n) => {
    expect(isReportRejection(err(n))).toBe(true);
  });
  it("a Lazer verification failure is final", () => {
    expect(isReportRejection([`Program ${LAZER_PROGRAM_ID} failed: invalid signature`])).toBe(true);
  });
  it.each(["WrongState", "WindowNotStarted", "WindowClosed", "WrongInstructionLayout"])("%s is retried", (n) => {
    expect(isReportRejection(err(n))).toBe(false);
  });
  it("balance and compute failures are retried", () => {
    expect(isReportRejection(["Program 11111111111111111111111111111111 failed: custom program error: 0x1"])).toBe(false);
    expect(isReportRejection(["Program X failed: exceeded CUs meter at BPF instruction"])).toBe(false);
  });
});
