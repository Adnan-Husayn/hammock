import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { Replays, DEMO_LABEL, DEMO_REPLAYS } from "../components/Replays";
import { bandSlope, lossLine, readout, SAMPLE_PREMIUM, snapFall, stepFall } from "../lib/line";
import { deps, market, OPEN } from "./fixtures";

describe("payoff line maths", () => {
  const prem = 200 * SAMPLE_PREMIUM;
  it("is flat across the 1% to 5% band at the suggested cover", () => {
    for (const f of [0.01, 0.015, 0.02, 0.03, 0.045, 0.05]) expect(readout(5000, f, 200, SAMPLE_PREMIUM).netLoss).toBeCloseTo(50 + prem, 9);
    expect(bandSlope(5000, 200)).toBeCloseTo(0, 12);
    expect(readout(5000, 0.03, 200, SAMPLE_PREMIUM).netLoss.toFixed(2)).toBe("73.91");
  });

  it("slopes upward inside the band for partial cover, but slower than no cover", () => {
    const a = readout(5000, 0.02, 100, SAMPLE_PREMIUM).netLoss, b = readout(5000, 0.04, 100, SAMPLE_PREMIUM).netLoss;
    expect(b - a).toBeCloseTo(50, 9); // $25 per 1% with half cover
    expect(b - a).toBeLessThan(5000 * 0.02); // uncovered rises $100 over the same 2%
    expect(bandSlope(5000, 100)).toBeCloseTo(25, 9);
  });

  it("loss resumes past 5% at the full uncovered rate", () => {
    const at5 = readout(5000, 0.05, 200, SAMPLE_PREMIUM).netLoss, at8 = readout(5000, 0.08, 200, SAMPLE_PREMIUM).netLoss;
    expect(at8 - at5).toBeCloseTo(150, 9);
  });

  it("draws exactly with kinks only at 1% and 5%", () => {
    expect(lossLine(5000, 200, 0).map((p) => [p.fall, Math.round(p.loss * 100) / 100])).toEqual([[0, 0], [0.01, 50], [0.05, 50], [0.08, 200]]);
  });
});

describe("marker stepping", () => {
  it("arrows move 0.25% and land on the 1% and 5% detents", () => {
    expect(stepFall(0.03, "ArrowRight")).toBe(0.0325);
    expect(stepFall(0.03, "ArrowLeft")).toBe(0.0275);
    expect(stepFall(0.0093, "ArrowRight")).toBe(0.01);
    expect(stepFall(0.0475, "ArrowUp")).toBe(0.05);
    expect(stepFall(0, "ArrowLeft")).toBe(0);
    expect(stepFall(0.08, "ArrowRight")).toBe(0.08);
  });
  it("page keys stop at a detent before passing it", () => {
    expect(stepFall(0.005, "PageUp")).toBe(0.01);
    expect(stepFall(0.045, "PageUp")).toBe(0.05);
    expect(stepFall(0.055, "PageDown")).toBe(0.05);
    expect(stepFall(0.03, "PageUp")).toBe(0.04);
    expect(stepFall(0.03, "End")).toBe(0.08);
  });
  it("drags stick to a detent when close", () => {
    expect(snapFall(0.0112)).toBe(0.01);
    expect(snapFall(0.0489)).toBe(0.05);
    expect(snapFall(0.03004)).toBe(0.03);
    expect(snapFall(-1)).toBe(0);
  });
});

describe("replays", () => {
  it("demo replays are labelled and never marked verified", async () => {
    const { container } = render(<Replays deps={deps({ market: null })} />);
    for (const r of DEMO_REPLAYS) {
      await act(async () => fireEvent.click(within(screen.getByRole("group", { name: "Demo weekend" })).getByRole("button", { name: r.name })));
      expect(screen.getByTestId("demo-label").textContent).toBe(DEMO_LABEL);
      expect(screen.getByTestId("receipt").getAttribute("data-kind")).toBe("demo");
      expect(screen.getByTestId("source-label").textContent).toBe(DEMO_LABEL);
      expect(screen.queryByTestId("verified-badge")).toBeNull();
      expect(container.textContent).not.toMatch(/verified pyth|final/i);
    }
  });
  it("demo maths: no payout, partial, cap", async () => {
    render(<Replays deps={deps({ market: null })} />);
    const pick = (n: string) => act(async () => fireEvent.click(screen.getByRole("button", { name: n })));
    await pick("No payout");
    expect(screen.getByTestId("receipt-payout").textContent).toBe("200 x $0.00 = $0.00");
    await pick("Partial fall");
    expect(screen.getByTestId("receipt-payout").textContent).toBe("200 x $0.40 = $80.00");
    await pick("Cap");
    expect(screen.getByTestId("receipt-payout").textContent).toBe("200 x $1.00 = $200.00");
  });
  it("verified replay waits for a configured market", async () => {
    render(<Replays deps={deps({ market: null })} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verified replay" })));
    expect(screen.getByTestId("verified-empty")).toBeTruthy();
  });
});

describe("page", () => {
  it("keeps both price tracks apart and avoids promise words", async () => {
    const { container } = render(<App deps={deps({ market: market({ buyingClosed: true }) })} />);
    await screen.findByTestId("state-card");
    await act(async () => fireEvent.click(screen.getByTestId("see-how")));
    expect(screen.getByText(/^decide the payout/)).toBeTruthy();
    expect(screen.getByText(/does not decide the payout/)).toBeTruthy();
    expect(container.textContent).not.toMatch(OPEN);
    expect(container.textContent).not.toMatch(/guarantee|protected|\bsafe\b/i);
  });
});
