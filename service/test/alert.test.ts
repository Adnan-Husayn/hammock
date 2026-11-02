import { describe, expect, it, vi } from "vitest";
import { ALERT_PER_HOUR, ALERT_REPEAT_MS, Alerter } from "../src/alert.ts";

function stub() {
  const calls: { url: string; body: any }[] = [];
  const f = vi.fn(async (url: string, init: { body: string }) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 }));
  return { calls, f };
}

describe("Alerter", () => {
  it("does nothing without ALERT_WEBHOOK_URL", () => {
    const { f } = stub();
    expect(new Alerter(undefined, f).alert("k", "x")).toBe(false);
    expect(new Alerter("  ", f).alert("k", "x")).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("POSTs short JSON with URLs stripped", async () => {
    const { calls, f } = stub();
    new Alerter("https://hooks.example/abc", f, () => 5).alert("k", "keeper failed: fetch https://rpc.example/?api-key=secret");
    await Promise.resolve();
    expect(calls[0].url).toBe("https://hooks.example/abc");
    expect(calls[0].body).toEqual({ text: "keeper failed: fetch [url]", source: "gap-cover-service", atMs: 5 });
  });

  it("repeats a key at most once per 10 minutes, and caps all alerts per hour", () => {
    const { f } = stub();
    let t = 0;
    const a = new Alerter("https://hooks.example/x", f, () => t);
    expect(a.alert("k", "one")).toBe(true);
    expect(a.alert("k", "two")).toBe(false);
    t += ALERT_REPEAT_MS;
    expect(a.alert("k", "three")).toBe(true);
    for (let i = 0; i < ALERT_PER_HOUR; i++) a.alert(`other${i}`, "x");
    expect(f).toHaveBeenCalledTimes(ALERT_PER_HOUR);
    t += 3_600_000;
    expect(a.alert("fresh", "x")).toBe(true);
  });

  it("logs and swallows a failing webhook", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    new Alerter("https://hooks.example/x", async () => { throw new Error("down https://hooks.example/x"); }).alert("k", "x");
    await new Promise((r) => setTimeout(r, 0));
    expect(log.mock.calls.flat().join()).toMatch(/alert webhook failed: down \[url\]/);
    log.mockRestore();
  });
});
