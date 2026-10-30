import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { isReportRejection, sendSubmitReport } from "../src/chain.ts";
import { fixture } from "./helpers.ts";
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

describe("sendSubmitReport", () => {
  const message = Buffer.from(fixture("regular-2026-10-29").solana.data, "hex");
  const conn = (over: any) => ({
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
    ...over,
  }) as any;
  const send = (c: any) => sendSubmitReport(c, Keypair.generate().publicKey, Keypair.generate(), Keypair.generate().publicKey, "friday", message);

  it("is true when confirmed", async () => {
    await expect(send(conn({}))).resolves.toBe(true);
  });
  it("throws, so the keeper retries, when it fails on landing", async () => {
    await expect(send(conn({ confirmTransaction: async () => ({ value: { err: "x" } }) }))).rejects.toThrow(/landing/);
  });
  it("is false only for a report-specific preflight rejection", async () => {
    const fail = (name: string) => conn({ sendRawTransaction: async () => { throw Object.assign(new Error("sim"), { logs: [`Error Code: ${name}. x`] }); } });
    await expect(send(fail("WideConfidence"))).resolves.toBe(false);
    await expect(send(fail("WrongState"))).rejects.toThrow("sim");
  });
});
