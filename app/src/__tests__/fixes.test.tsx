import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import App from "../App";
import { BuyPanel } from "../components/BuyPanel";
import { ProofScreen } from "../components/ProofScreen";
import { deps, market, pk, quote } from "./fixtures";

afterEach(() => vi.useRealTimers());
const buyButton = () => screen.getByRole("button", { name: /^buy/i }) as HTMLButtonElement;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe("quote expiry margin", () => {
  it("refreshes at expiry - 10 s and blocks buying until the new quote arrives", async () => {
    vi.useFakeTimers();
    const d = deps({ market: market() });
    d.now = () => Date.now();
    const t0 = Math.floor(Date.now() / 1000);
    let release!: (q: any) => void;
    const q = vi.fn()
      .mockResolvedValueOnce(quote({ expiry: t0 + 60 }))
      .mockImplementationOnce(() => new Promise((r) => { release = r; }));
    d.service.quote = q;
    render(<BuyPanel deps={d} market={pk()} info={market()} contracts={200} />);
    await flush();
    expect(buyButton().disabled).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(49_000); });
    expect(q).toHaveBeenCalledTimes(1);
    expect(buyButton().disabled).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(q).toHaveBeenCalledTimes(2);
    expect(buyButton().disabled).toBe(true);

    await act(async () => { release(quote({ expiry: t0 + 111 })); await vi.advanceTimersByTimeAsync(0); });
    expect(buyButton().disabled).toBe(false);
  });

  it("keeps the 60 s refresh", async () => {
    vi.useFakeTimers();
    const d = deps({ market: market() });
    d.now = () => Date.now();
    const q = vi.fn(async () => quote({ expiry: Math.floor(Date.now() / 1000) + 600 }));
    d.service.quote = q;
    render(<BuyPanel deps={d} market={pk()} info={market()} contracts={200} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(q).toHaveBeenCalledTimes(2);
  });

  it("blocks a quote that arrives already inside the margin", async () => {
    const d = deps({ market: market() });
    d.now = () => Date.now();
    d.service.quote = vi.fn(async () => quote({ expiry: Math.floor(Date.now() / 1000) + 5 }));
    render(<BuyPanel deps={d} market={pk()} info={market()} contracts={200} />);
    await screen.findByText("Total premium");
    expect(buyButton().disabled).toBe(true);
    expect(d.wallet!.signTransaction).not.toHaveBeenCalled();
  });
});

describe("escrow on the proof screen", () => {
  const base = { contractsSold: 200, totalPremiums: 24_000_000n, payoutPerContract: 250_000n };
  const cases = [
    ["FridayFinal", "Escrow before finalisation, fully collateralised", "$200.00"],
    ["MondayFinal", "Escrow at finalisation, kept for payouts", "$50.00"],
    ["Voided", "Escrow at finalisation, kept for refunds", "$24.00"],
  ] as const;
  for (const [state, label, value] of cases) {
    it(`${state}: ${value}`, async () => {
      const m = market({ ...base, state });
      render(<ProofScreen deps={deps({ market: m })} market={pk()} info={m} />);
      await act(async () => {});
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByTestId("escrow").textContent).toBe(value);
    });
  }
});

describe("buying copy", () => {
  it("comes from buying_close_ts", async () => {
    // 2026-11-29 22:50 UTC is Sunday 17:50 in New York; 2026-11-28 15:00 UTC is Saturday 10:00.
    const nowMs = Date.UTC(2026, 10, 28, 12);
    const d1 = deps({ market: market({ buyingCloseTs: BigInt(Date.UTC(2026, 10, 29, 22, 50) / 1000) }) });
    d1.now = () => nowMs;
    const a = render(<App deps={d1} />);
    expect((await screen.findByTestId("state-card")).textContent).toContain("until Sunday 17:50 ET");
    a.unmount();
    const d2 = deps({ market: market({ buyingCloseTs: BigInt(Date.UTC(2026, 10, 28, 15) / 1000) }) });
    d2.now = () => nowMs;
    render(<App deps={d2} />);
    expect((await screen.findByTestId("state-card")).textContent).toContain("until Saturday 10:00 ET");
  });
});
