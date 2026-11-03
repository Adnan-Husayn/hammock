import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { Sandbox } from "../components/Sandbox";
import { enabledStocks, parseMarketList } from "../lib/markets";
import { deps, market, OPEN, pk } from "./fixtures";

describe("stock picker", () => {
  it("offers NVDA, TSLA, SPY and AAPL by default and VITE_SYMBOLS can narrow it", () => {
    expect(enabledStocks().map((s) => s.symbol)).toEqual(["NVDA", "TSLA", "SPY", "AAPL"]);
    expect(enabledStocks("tsla,XYZ").map((s) => s.symbol)).toEqual(["TSLA"]);
    expect(parseMarketList("NVDA=a, tsla=b,bad")).toEqual({ NVDA: "a", TSLA: "b" });
  });

  it("switching stock reads that stock's market and puts the symbol in the copy", async () => {
    const nvda = pk(), tsla = pk();
    const d = deps({ market: market() });
    d.realMarkets = { NVDA: nvda, TSLA: tsla, SPY: null, AAPL: null };
    d.stocks = enabledStocks();
    const { container } = render(<App deps={d} />);
    const group = screen.getByRole("group", { name: "Stock" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["NVDA", "TSLA", "SPY", "AAPL"]);
    await screen.findByText("NVDA: Buying now");
    expect(screen.getByTestId("holding-line").textContent).toBe("Your holding: $5,000 NVDAx");
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "TSLA" })));
    await screen.findByText("TSLA: Buying now");
    expect(screen.getByTestId("holding-line").textContent).toBe("Your holding: $5,000 TSLAx");
    expect((d.chain.readMarket as any).mock.calls.map((c: any[]) => c[0].toBase58())).toEqual([nvda.toBase58(), tsla.toBase58()]);
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "SPY" })));
    await screen.findByText("No live SPY market this weekend");
    // Outside the picker, nothing names another stock.
    const rest = container.textContent!.replace(group.textContent!, "");
    expect(rest).not.toMatch(/NVDA|TSLA|AAPL/);
    expect(container.textContent).not.toMatch(OPEN);
  });

  it("sandbox and faucet use the chosen stock", async () => {
    const d = deps({ market: market({ sandbox: true, feedId: 922 }) });
    const { container } = render(<Sandbox deps={d} symbol="AAPL" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Get demo tokens" })));
    await screen.findByText("Demo USDC and AAPLx (test) sent to your wallet.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /gap mode/i })));
    expect(d.service.startSandbox).toHaveBeenCalledWith("gap", "AAPL");
    expect((d.service.faucet as any).mock.calls[0][1]).toBe("AAPL");
    expect(container.textContent).not.toMatch(/NVDA/);
    expect(container.textContent).not.toMatch(OPEN);
  });

  it("an active cover prices the weekend estimate off the market's own stock", async () => {
    const d = deps({ market: market({ feedId: 1435 }) });
    d.chain.readPosition = async () => ({ contracts: 200, premiumPaid: 24_000_000n, lastNonce: 1n, closed: false });
    d.realMarkets = { NVDA: null, TSLA: pk(), SPY: null, AAPL: null };
    render(<App deps={d} />);
    await act(async () => fireEvent.click(within(screen.getByRole("group", { name: "Stock" })).getByRole("button", { name: "TSLA" })));
    await screen.findByTestId("weekend-note");
    expect(d.chain.referencePrice).toHaveBeenCalledWith("TSLA");
    expect(screen.getByTestId("weekend-note").textContent).toMatch(/^Weekend TSLAx, estimate\. Does not decide the payout\./);
  });
});
