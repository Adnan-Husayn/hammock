import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Calculator } from "../components/Calculator";
import { netLoss, payoutPerContract, suggestedContracts } from "../lib/program";

describe("calculator", () => {
  it("a $5,000 holding suggests 200 contracts", () => {
    expect(suggestedContracts(5000)).toBe(200);
    render(<Calculator symbol="NVDA" />);
    expect(screen.getByTestId("contracts").textContent).toBe("200");
  });

  it("net loss at a 2% fall equals $100 - $50 + premium", () => {
    expect(payoutPerContract(0.02)).toBeCloseTo(0.25);
    expect(netLoss(5000, 0.02, 200, 24)).toBeCloseTo(100 - 50 + 24);
    render(<Calculator symbol="NVDA" premiumPerContract={0.12} />);
    expect(screen.getByTestId("net-loss").textContent).toBe("$74.00");
  });

  it("pays nothing at 1% or less and $1 at 5% or more", () => {
    expect(payoutPerContract(0.01)).toBe(0);
    expect(payoutPerContract(-0.03)).toBe(0);
    expect(payoutPerContract(0.05)).toBe(1);
    expect(payoutPerContract(0.08)).toBe(1);
  });
});

import { ata } from "../lib/program";
import { PublicKey } from "@solana/web3.js";
it("ata matches a token account that exists on devnet", () => {
  const got = ata(new PublicKey("D4FBcrtAekxBVpfuLszzpfmiGtSeuaVgjDXFSaFcnXBJ"), new PublicKey("FXLBEHLaPRPQApBM9CjeanpqLqdVsf5rwWRTXsWoUy1L"));
  expect(["DJxNyJN6MXuNaCJtTtAdapRV3pcDMw9NKCQPUw8PHCdZ", "5J4eEoiXk9XDi7UEhNu8mKrLzhpY1qnutubNRLeXfodg"]).toContain(got.toBase58());
});
