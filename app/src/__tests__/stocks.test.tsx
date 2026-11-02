import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { Sandbox } from "../components/Sandbox";
import { LockedView } from "../components/LockedView";
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
    expect(screen.getByText("What cover does for your NVDAx")).toBeTruthy();
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "TSLA" })));
    await screen.findByText("TSLA: Buying now");
    expect(screen.getByText("What cover does for your TSLAx")).toBeTruthy();
    expect(screen.getByText("TSLA fall by Monday (%)")).toBeTruthy();
    expect((d.chain.readMarket as any).mock.calls.map((c: any[]) => c[0].toBase58())).toEqual([nvda.toBase58(), tsla.toBase58()]);
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "SPY" })));
    await screen.findByText("No SPY market this weekend");
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

  it("locked view prices off the market's own stock", async () => {
    const d = deps({ market: market() });
    render(<LockedView deps={d} market={pk()} info={market({ buyingClosed: true, feedId: 1435 })} />);
    await screen.findByText(/live TSLAx price/);
    expect(d.chain.referencePrice).toHaveBeenCalledWith("TSLA");
  });
});
