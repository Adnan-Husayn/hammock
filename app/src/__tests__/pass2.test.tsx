import { describe, expect, it, vi } from "vitest";
import css from "../styles.css?raw";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { Calculator } from "../components/Calculator";
import { article, readout, SAMPLE_PREMIUM } from "../lib/line";
import { signedRow } from "../components/Calculator";
import { PHONE_TICKS } from "../components/PayoffChart";
import { PRODUCT_NAME } from "../brand";
import { deps, market, OPEN } from "./fixtures";

describe("signed arithmetic", () => {
  it("shows one signed row and minus signs on every loss", () => {
    expect(signedRow(readout(5000, 0.03, 200, SAMPLE_PREMIUM)).map(([k, v]) => `${k} ${v}`).join(" · ")).toBe("Stock loss -$150.00 · Payout +$100.00 · Premium -$23.91 · Net -$73.91");
    const { container } = render(<Calculator symbol="NVDA" />);
    expect(screen.getByTestId("arith").textContent).toBe("Stock loss -$150.00 · Payout +$100.00 · Premium -$23.91 · Net -$73.91");
    expect(screen.getByTestId("net-loss").textContent).toBe("-$73.91");
    expect(screen.getByTestId("uncovered").textContent).toBe("without cover -$150.00");
    expect(screen.getByTestId("net-loss").parentElement).toBe(screen.getByTestId("uncovered").parentElement);
    expect(screen.getByTestId("flat-label").textContent).toBe("flat at -$73.91");
    expect(container.querySelector(".readout")).toBeNull();
    expect(container.textContent).not.toMatch(/ = Net loss/);
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
    expect(screen.getByTestId("instrument").getAttribute("data-mode")).toBe("Live market");
    const modes = screen.getByRole("group", { name: "Instrument mode" });
    expect(within(modes).getAllByRole("button").map((b) => b.textContent)).toEqual(["Calculator", "No payout", "Partial fall", "Cap", "Void"]);
    await act(async () => fireEvent.click(within(modes).getByRole("button", { name: "Cap" })));
    expect(container.querySelectorAll("[data-testid=payoff-chart]").length).toBe(1);
    expect(screen.getByTestId("instrument").getAttribute("data-mode")).toBe("Demo replay");
    expect(screen.getByTestId("arith").textContent).toBe("Stock loss -$350.00 · Payout +$200.00 · Premium -$23.91 · Net -$173.91");
    expect(screen.queryByRole("slider", { name: "Monday fall" })).toBeNull();
    // the receipt below follows the same pick
    expect(within(screen.getByRole("group", { name: "Demo weekend" })).getByRole("button", { name: "Cap" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(within(modes).getByRole("button", { name: "Void" })));
    expect(screen.getByTestId("net-loss").textContent).toBe("$0.00");
    await act(async () => fireEvent.click(within(modes).getByRole("button", { name: "Calculator" })));
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
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Keep the token. Know your loss on a 1% to 5% Monday fall.");
    expect(screen.getByText("Solana devnet, demo tokens")).toBeTruthy();
    expect(container.textContent).not.toMatch(/;|gasless|30 seconds/i);
    expect(container.textContent).not.toMatch(OPEN);
  });
});

describe("palette", () => {
  it("has no purple and restyles the wallet button", () => {
    expect(css).toMatch(/\.wallet-adapter-button-trigger[^{]*\{[^}]*border:1px solid var\(--ink\)/);
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
    expect(screen.getByTestId("premium-note").textContent).toMatch(/^Sample premium: \$0\.11955 per contract\. A wallet gets a real quote\./);
    expect(container.querySelectorAll(".controls > label").length).toBe(3);
  });
  it("keeps the stock pills and the devnet pill in one group in the header", async () => {
    render(<App deps={deps({ market: null })} />);
    await screen.findByTestId("state-card");
    expect(within(screen.getByRole("group", { name: "Stock" })).getByText("Solana devnet, demo tokens")).toBeTruthy();
  });
});

describe("figures", () => {
  it("never wrap mid-number", () => {
    const { container } = render(<Calculator symbol="NVDA" />);
    const parts = container.querySelectorAll("[data-testid=arith] > span");
    expect(parts.length).toBe(4);
    for (const d of parts) expect(d.classList.contains("fig")).toBe(true);
    expect(screen.getByTestId("net-loss").classList.contains("fig")).toBe(true);
    expect(css).toMatch(/\.fig\s*\{\s*white-space:nowrap/);
  });
});

describe("pass 4", () => {
  it("phone x-axis keeps the 1% and 5% ticks", () => {
    expect(PHONE_TICKS).toEqual(expect.arrayContaining([0.01, 0.05]));
  });
  it("has exactly one solid primary button and an outlined wallet button", async () => {
    const { container } = render(<App deps={deps({ market: null })} />);
    await screen.findByTestId("state-card");
    const primaries = container.querySelectorAll("button.primary");
    expect(primaries.length).toBe(1);
    expect(primaries[0].getAttribute("data-testid")).toBe("run-weekend");
    expect(css).toMatch(/\.wallet-adapter-button-trigger[^{]*\{[^}]*background:transparent/);
  });
  it("puts the same market state in the run strip and the instrument", async () => {
    render(<App deps={deps({ market: null })} />);
    const card = await screen.findByTestId("state-card");
    expect(screen.getByTestId("strip-state").textContent).toBe("No live NVDA market this weekend. Try a demo replay or run a demo weekend.");
    expect(card.textContent).toBe(screen.getByTestId("strip-state").textContent);
  });
  it("the fall field and the marker are linked", () => {
    render(<Calculator symbol="NVDA" />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Monday fall" }), { key: "PageUp" });
    expect((screen.getByTestId("fall-input") as HTMLInputElement).value).toBe("4");
  });
});
