import { describe, expect, it, vi } from "vitest";
import css from "../styles.css?raw";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { Calculator } from "../components/Calculator";
import { article, equationLine, readout, SAMPLE_PREMIUM } from "../lib/line";
import { PRODUCT_NAME } from "../brand";
import { deps, market, OPEN } from "./fixtures";

describe("equation line", () => {
  it("reconciles stock loss, payout and premium in one signed line", () => {
    expect(equationLine(readout(5000, 0.03, 200, SAMPLE_PREMIUM))).toBe("Stock loss -$150.00 + Payout $100.00 - Premium $23.91 = Net loss -$73.91");
    render(<Calculator symbol="NVDA" />);
    expect(screen.getByTestId("equation").textContent).toBe("Stock loss -$150.00 + Payout $100.00 - Premium $23.91 = Net loss -$73.91");
    expect(screen.getByTestId("uncovered").textContent).toBe("without cover -$150.00");
    expect(screen.getByTestId("flat-label").textContent).toBe("flat at -$73.91");
  });
});

describe("article per symbol", () => {
  it("reads tickers letter by letter", () => {
    expect(["NVDA", "TSLA", "SPY", "AAPL"].map((s) => `${article(s)} ${s}`)).toEqual(["an NVDA", "a TSLA", "an SPY", "an AAPL"]);
  });
  it("labels the run button with the right article", async () => {
    render(<App deps={deps({ market: null })} />);
    await screen.findByTestId("state-card");
    expect(screen.getByTestId("run-weekend").textContent).toBe("Run an NVDA weekend");
    await act(async () => fireEvent.click(within(screen.getByRole("group", { name: "Stock" })).getByRole("button", { name: "TSLA" })));
    expect(screen.getByTestId("run-weekend").textContent).toBe("Run a TSLA weekend");
  });
});

describe("page", () => {
  it("draws one chart, also during a demo replay", async () => {
    const { container } = render(<App deps={deps({ market: market() })} />);
    await screen.findByTestId("state-card");
    expect(container.querySelectorAll("[data-testid=payoff-chart]").length).toBe(1);
    expect(screen.getByTestId("mode-badge").textContent).toBe("Live market");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cap" })));
    expect(container.querySelectorAll("[data-testid=payoff-chart]").length).toBe(1);
    expect(screen.getByTestId("mode-badge").textContent).toBe("Demo replay");
    expect(screen.queryByRole("slider", { name: "Monday fall" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back to the calculator" })));
    expect(screen.getByRole("slider", { name: "Monday fall" })).toBeTruthy();
    expect(container.querySelectorAll("[data-testid=payoff-chart]").length).toBe(1);
  });

  it("without a wallet the run button is enabled and opens the wallet selector", async () => {
    const onConnect = vi.fn();
    const d = deps({ market: null, wallet: false });
    render(<App deps={d} onConnectWallet={onConnect} />);
    await screen.findByTestId("state-card");
    const b = screen.getByTestId("run-weekend") as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    await act(async () => fireEvent.click(b));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(d.service.faucet).not.toHaveBeenCalled();
  });

  it("shows the name from one constant, the headline and no semicolons or open", async () => {
    const { container } = render(<App deps={deps({ market: market() })} />);
    await screen.findByTestId("state-card");
    expect(screen.getByText(PRODUCT_NAME)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hold your stock token through the weekend without carrying the whole fall.");
    expect(screen.getByText("Solana devnet, demo tokens")).toBeTruthy();
    expect(container.textContent).not.toMatch(/;|gasless|30 seconds/i);
    expect(container.textContent).not.toMatch(OPEN);
  });
});

describe("palette", () => {
  it("has no purple and restyles the wallet button", () => {
    expect(css).toMatch(/\.wallet-adapter-button-trigger[^{]*\{[^}]*background:var\(--ink\)/);
    for (const [hex] of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d < 0.08) continue;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const hue = (h * 60 + 360) % 360;
      expect(hue >= 255 && hue <= 330, `${hex} is purple`).toBe(false);
    }
    expect(css).not.toMatch(/purple|violet|#512da8/i);
  });
});

describe("pass 3", () => {
  it("puts the flat label above the line, on the side away from the marker", () => {
    render(<Calculator symbol="NVDA" />);
    const handle = screen.getByRole("slider", { name: "Monday fall" });
    const label = () => screen.getByTestId("flat-label");
    const lineY = () => Number(screen.getByRole("slider").querySelector(".dot")!.getAttribute("cy"));
    for (let i = 0; i < 4; i++) fireEvent.keyDown(handle, { key: "ArrowLeft" }); // 2%
    expect(label().getAttribute("data-side")).toBe("right");
    expect(Number(label().getAttribute("y"))).toBeLessThan(lineY() - 11);
    for (let i = 0; i < 8; i++) fireEvent.keyDown(handle, { key: "ArrowRight" }); // 4%
    expect(label().getAttribute("data-side")).toBe("left");
  });
  it("labels the sample premium quietly and keeps the fall field in the control strip", () => {
    const { container } = render(<Calculator symbol="NVDA" />);
    expect(screen.getByText("Premium, sample until quoted", { selector: "dt" })).toBeTruthy();
    expect(container.querySelectorAll(".controls > label").length).toBe(3);
  });
  it("keeps the stock pills and the devnet pill in one group in the header", async () => {
    render(<App deps={deps({ market: null })} />);
    await screen.findByTestId("state-card");
    expect(within(screen.getByRole("group", { name: "Stock" })).getByText("Solana devnet, demo tokens")).toBeTruthy();
  });
});
