import { describe, expect, it, vi } from "vitest";
import css from "../styles.css?raw";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../App";
import { article } from "../lib/line";
import { PHONE_TICKS } from "../components/PayoffChart";
import { PRODUCT_NAME } from "../brand";
import { deps, market, OPEN } from "./fixtures";

describe("article per symbol", () => {
  it("reads tickers letter by letter", () => {
    expect(["NVDA", "TSLA", "SPY", "AAPL"].map((s) => `${article(s)} ${s}`)).toEqual(["an NVDA", "a TSLA", "an SPY", "an AAPL"]);
  });
  it("labels the devnet run button with the right article", async () => {
    render(<App deps={deps({ market: null })} />);
    await act(async () => fireEvent.click(screen.getByTestId("see-how")));
    expect(screen.getByTestId("run-devnet").textContent).toBe("Run an NVDA weekend on devnet");
    await act(async () => fireEvent.click(within(screen.getByRole("group", { name: "Stock" })).getByRole("button", { name: "TSLA" })));
    expect(screen.getByTestId("run-devnet").textContent).toBe("Run a TSLA weekend on devnet");
  });
});

describe("page", () => {
  it("without a wallet the devnet run opens the wallet selector", async () => {
    const onConnect = vi.fn();
    const d = deps({ market: null, wallet: false });
    render(<App deps={d} onConnectWallet={onConnect} />);
    await act(async () => fireEvent.click(screen.getByTestId("see-how")));
    const b = screen.getByTestId("run-devnet") as HTMLButtonElement;
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

  it("has exactly one solid primary button on the landing and an outlined wallet button", async () => {
    const { container } = render(<App deps={deps({ market: null })} />);
    await screen.findByTestId("state-card");
    const primaries = container.querySelectorAll("button.primary");
    expect(primaries.length).toBe(1);
    expect(primaries[0].textContent).toBe("Run a demo weekend");
    expect(css).toMatch(/\.wallet-adapter-button-trigger[^{]*\{[^}]*background:transparent/);
  });

  it("states the market once with a link that focuses the replay pills", async () => {
    render(<App deps={deps({ market: null })} />);
    const card = await screen.findByTestId("state-card");
    expect(card.textContent).toBe("No live NVDA market this weekend. Run a demo weekend or inspect a replay.");
    await act(async () => fireEvent.click(screen.getByTestId("inspect-replay")));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement?.textContent).toBe("No payout");
  });

  it("keeps the stock pills and the devnet pill apart in the header", async () => {
    render(<App deps={deps({ market: null })} />);
    const env = screen.getByText("Solana devnet, demo tokens");
    expect(env.parentElement).toBe(screen.getByTestId("theme-toggle").parentElement);
    expect(env.parentElement!.contains(screen.getByRole("group", { name: "Stock" }))).toBe(false);
  });

  it("shows the certainty label with a live market", async () => {
    render(<App deps={deps({ market: market() })} />);
    const card = await screen.findByTestId("state-card");
    expect(card.querySelector(".tag")?.textContent).toBe("estimate");
  });
});

describe("palette and figures", () => {
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
  it("figures never wrap mid-number and the phone axis keeps 1% and 5%", () => {
    expect(css).toMatch(/\.fig\s*\{\s*white-space:nowrap/);
    expect(PHONE_TICKS).toEqual(expect.arrayContaining([0.01, 0.05]));
  });
  it("cycles system, light, dark and remembers the choice", async () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    document.documentElement.removeAttribute("data-theme");
    render(<App deps={deps({ market: null })} />);
    const b = screen.getByTestId("theme-toggle");
    expect(b.getAttribute("data-theme-choice")).toBe("system");
    expect(b.textContent).toBe(" Theme: Auto");
    fireEvent.click(b);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    fireEvent.click(b);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(b);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("theme")).toBeNull();
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    vi.unstubAllGlobals();
  });
});
