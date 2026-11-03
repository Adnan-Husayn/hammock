import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../App";
import { CoverCard } from "../components/CoverCard";
import { realStatus } from "../components/RealCover";
import { receiptText, STATUSES, sumLine, type CoverRecord } from "../lib/cover";
import { readout, SAMPLE_PREMIUM } from "../lib/line";
import { LEDGER_KEY, totals } from "../lib/ledger";
import { PRODUCT_NAME } from "../brand";
import { deps, market, NOW, OPEN, pk } from "./fixtures";

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() });
  return () => vi.unstubAllGlobals();
});

const click = (el: Element) => act(async () => fireEvent.click(el));

async function runDemoToActive() {
  const r = render(<App deps={deps({ market: null, wallet: false })} />);
  await screen.findByTestId("state-card");
  await click(screen.getByTestId("run-demo"));
  return r;
}

describe("status words", () => {
  it("uses exactly five statuses and never waiting, measuring or paid", () => {
    expect(STATUSES).toEqual(["Cover active", "Monday mark final", "Expired, no payout", "Claimed", "Voided"]);
    for (const s of STATUSES) expect(s).not.toMatch(/waiting|measuring|paid/i);
  });
  it("maps chain state and position to a status", () => {
    const pos = { contracts: 200, premiumPaid: 24_000_000n, lastNonce: 1n, closed: false };
    const mon = { price: 17_640_000n, feedTsUs: 1n, submitter: pk() };
    expect(realStatus(market(), pos)).toBe("Cover active");
    expect(realStatus(market({ buyingClosed: true }), pos)).toBe("Cover active");
    expect(realStatus(market({ state: "MondayFinal", monday: mon, payoutPerContract: 250_000n }), pos)).toBe("Monday mark final");
    expect(realStatus(market({ state: "MondayFinal", monday: mon, payoutPerContract: 250_000n }), { ...pos, closed: true })).toBe("Claimed");
    expect(realStatus(market({ state: "MondayFinal", monday: mon, payoutPerContract: 0n }), pos)).toBe("Expired, no payout");
    expect(realStatus(market({ state: "Voided" }), pos)).toBe("Voided");
  });
});

describe("numbers", () => {
  it("puts net loss beside the loss without cover on the landing card", async () => {
    render(<App deps={deps({ market: null, wallet: false })} />);
    await screen.findByTestId("state-card");
    expect(screen.getByTestId("holding-line").textContent).toBe("Demo holding: $5,000 NVDAx");
    expect(screen.getByTestId("net-loss").textContent).toBe("-$73.91");
    expect(screen.getByTestId("uncovered").textContent).toBe("without cover -$150.00");
    expect(screen.getByTestId("net-loss").parentElement).toBe(screen.getByTestId("uncovered").parentElement);
  });
  it("keeps the one-line sum visible", async () => {
    expect(sumLine(readout(5000, 0.03, 200, SAMPLE_PREMIUM))).toBe("stock -$150.00 + payout +$100.00 - premium $23.91 = net -$73.91");
    expect(sumLine(readout(5000, 0.005, 200, SAMPLE_PREMIUM))).toBe("stock -$25.00 + payout $0.00 - premium $23.91 = net -$48.91");
    render(<App deps={deps({ market: null, wallet: false })} />);
    await screen.findByTestId("state-card");
    expect(screen.getByTestId("sum-line").textContent).toBe("stock -$150.00 + payout +$100.00 - premium $23.91 = net -$73.91");
  });
});

describe("landing", () => {
  it("has the demo holding, the closed-market line and two actions, no form", async () => {
    const { container } = render(<App deps={deps({ market: null, wallet: false })} />);
    await screen.findByTestId("state-card");
    const landing = screen.getByTestId("landing");
    expect(screen.getByTestId("market-closed").textContent).toBe("Stock market closed for 65h 30m. Token still trades.");
    expect(within(landing).getAllByRole("button").map((b) => b.textContent)).toEqual(["Run a demo weekend", "See how cover works"]);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(screen.queryByTestId("ledger")).toBeNull();
  });
});

describe("two-step buy", () => {
  it("goes Choose cover, then Review & confirm, then the card shows Cover active", async () => {
    await runDemoToActive();
    const flow = screen.getByTestId("buy-flow");
    expect(flow.getAttribute("data-step")).toBe("choose");
    expect(within(flow).getByRole("heading").textContent).toBe("Choose cover");
    expect(within(flow).getByRole("group", { name: "Cover stock" })).toBeTruthy();
    expect((screen.getByTestId("holding-input") as HTMLInputElement).value).toBe("5000");
    expect((screen.getByTestId("cover-input") as HTMLInputElement).value).toBe("200");
    await click(screen.getByTestId("to-review"));
    expect(flow.getAttribute("data-step")).toBe("review");
    expect(within(flow).getByRole("heading").textContent).toBe("Review & confirm");
    const review = screen.getByTestId("review").textContent!;
    for (const k of ["Premium", "Payout cap", "Band", "Monday mark", "Quote expiry"]) expect(review).toContain(k);
    expect(screen.getByTestId("review-premium").textContent).toMatch(/^\$23\.91/);
    const rows = within(screen.getByTestId("outcomes")).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows).toEqual(["0%-$23.91$0.00", "3%-$73.91-$150.00", "8%-$223.91-$400.00"]);
    await click(screen.getByTestId("confirm-demo"));
    expect(screen.queryByTestId("buy-flow")).toBeNull();
    expect(screen.getByTestId("cover-status").textContent).toBe("Cover active");
    expect(screen.getByTestId("compressed").textContent).toContain("Demo time, compressed");
    expect(screen.getByTestId("sized-note").textContent).toBe("Sized for $5,000 at purchase; your token balance may differ.");
  });
});

describe("settlement in place", () => {
  it("turns the same card to Monday mark final with one Claim $100.00 USDC button, then Claimed", async () => {
    vi.spyOn(globalThis, "setTimeout");
    const { container } = await runDemoToActive();
    await click(screen.getByTestId("to-review"));
    await click(screen.getByTestId("confirm-demo"));
    const card = screen.getByTestId("cover-card");
    await click(screen.getByTestId("skip-monday"));
    expect(screen.getByTestId("cover-card")).toBe(card);
    expect(card.getAttribute("data-status")).toBe("Monday mark final");
    expect(within(card).getByTestId("settled-lines").textContent).toBe("Fall3%Payout$100.00Premium-$23.91");
    expect(within(card).getByTestId("net-loss").textContent).toBe("-$73.91");
    expect(within(card).getByTestId("uncovered").textContent).toBe("without cover -$150.00");
    const primaries = card.querySelectorAll("button.primary");
    expect(primaries.length).toBe(1);
    expect(primaries[0].textContent).toBe("Claim $100.00 USDC");
    // demo marker is never blue
    expect(card.querySelector("[data-testid=fall-marker]")!.getAttribute("data-verified")).toBe("false");
    await click(primaries[0]);
    expect(screen.getByTestId("cover-card")).toBe(card);
    expect(card.getAttribute("data-status")).toBe("Claimed");
    expect(card.querySelectorAll("button.primary").length).toBe(0);
    expect(container.textContent).not.toMatch(/congrat|confetti|🎉|!/i);
    expect(container.textContent).not.toMatch(OPEN);
    vi.restoreAllMocks();
  });

  it("settles by itself after the compressed weekend", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<App deps={deps({ market: null, wallet: false })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await click(screen.getByTestId("run-demo"));
    await click(screen.getByTestId("to-review"));
    await click(screen.getByTestId("confirm-demo"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("cover-status").textContent).toBe("Monday mark final");
    vi.useRealTimers();
  });
});

describe("ledger", () => {
  it("appears once a cover exists, keeps demo totals apart and offers next weekend", async () => {
    await runDemoToActive();
    await click(screen.getByTestId("to-review"));
    await click(screen.getByTestId("confirm-demo"));
    const ledger = screen.getByTestId("ledger");
    expect(within(ledger).getByText("Active")).toBeTruthy();
    await click(screen.getByTestId("skip-monday"));
    await click(screen.getByRole("button", { name: "Claim $100.00 USDC" }));
    expect(within(ledger).getByText("Past")).toBeTruthy();
    expect(screen.getByTestId("totals-demo").textContent).toBe("Demo totals, no real moneyPremiums paid$23.91Payouts claimed$100.00Net$76.09");
    expect(screen.queryByTestId("totals-real")).toBeNull();
    expect(screen.getByTestId("next-friday").textContent).toMatch(/^Fri \d+ \w+, 16:00 ET$/);
    expect(screen.getByTestId("buy-by").textContent).toMatch(/^Sun \d+ \w+, 17:50 ET$/);
    expect(JSON.parse(localStorage.getItem(LEDGER_KEY)!)[0].status).toBe("Claimed");
    await click(screen.getByTestId("cover-next"));
    expect(screen.getByTestId("buy-flow").getAttribute("data-step")).toBe("choose");
    expect(ledger.textContent).not.toMatch(/points|streak|badge/i);
  });
  it("totals count a void as no premium", () => {
    const base = { id: "a", kind: "demo" as const, symbol: "NVDA", holding: 5000, contracts: 200, premium: 23.91, fridayPrice: 180, fridayAt: null, mondayAt: null, mondayPrice: null };
    expect(totals([{ ...base, status: "Voided" }, { ...base, id: "b", status: "Expired, no payout" }], "demo")).toEqual({ premiums: 23.91, payouts: 0, net: -23.91, count: 2 });
  });
});

describe("sharing", () => {
  it("has no share button, only Export receipt with premium, net loss and the demo label", async () => {
    const { container } = await runDemoToActive();
    await click(screen.getByTestId("to-review"));
    await click(screen.getByTestId("confirm-demo"));
    await click(screen.getByTestId("skip-monday"));
    expect(screen.queryByRole("button", { name: /share|tweet|post/i })).toBeNull();
    expect(container.textContent).not.toMatch(/share/i);
    expect(screen.getByTestId("export-receipt").textContent).toBe("Export receipt");
    const c: CoverRecord = { id: "x", kind: "demo", symbol: "NVDA", holding: 5000, contracts: 200, premium: 23.91, fridayPrice: 180, fridayAt: NOW, mondayAt: NOW, mondayPrice: 174.6, status: "Claimed" };
    const t = receiptText(c, PRODUCT_NAME);
    expect(t).toContain("Premium: $23.91");
    expect(t).toContain("Net loss: -$73.91 (without cover -$150.00)");
    expect(t).toContain("Demo prices, not Pyth, not a settlement");
    expect(t.startsWith(PRODUCT_NAME)).toBe(true);
    expect(t).not.toMatch(OPEN);
    const onExport = vi.fn();
    render(<CoverCard c={c} holdingLabel="Demo holding" onExport={onExport} />);
    await click(screen.getAllByTestId("export-receipt")[1]);
    expect(onExport).toHaveBeenCalledWith(c);
  });
});

describe("proof marker", () => {
  const settled = market({
    state: "MondayFinal", contractsSold: 200, payoutPerContract: 250_000n, settledAt: BigInt(NOW / 1000),
    monday: { price: 17_640_000n, feedTsUs: BigInt(NOW) * 1000n, submitter: pk() },
  });
  it("turns blue only when the marks match the archive, and claims in place", async () => {
    const d = deps({ market: settled });
    let closed = false;
    d.chain.readPosition = vi.fn(async () => ({ contracts: 200, premiumPaid: 24_000_000n, lastNonce: 1n, closed }));
    d.service.archive = vi.fn(async (_m: string, leg: "friday" | "monday") => [{
      feedTsUs: (leg === "friday" ? settled.friday! : settled.monday!).feedTsUs.toString(), timestampUs: "0",
      price: "0", exponent: -5, confidence: "1", publishers: 21, session: "regular", hash: "ab",
    }]);
    render(<App deps={d} />);
    const card = await screen.findByTestId("cover-card", {}, { timeout: 2000 }).then(() => waitFor(() => {
      const c = screen.getAllByTestId("cover-card").find((x) => x.getAttribute("data-status") === "Monday mark final");
      expect(c).toBeTruthy();
      return c!;
    }));
    await waitFor(() => expect(card.querySelector("[data-testid=fall-marker]")!.getAttribute("data-verified")).toBe("true"));
    expect(within(card).getByTestId("holding-line").textContent).toBe("Your holding: $5,000 NVDAx");
    const claim = await within(card).findByRole("button", { name: "Claim $50.00 USDC" });
    closed = true;
    await click(claim);
    await waitFor(() => expect(card.getAttribute("data-status")).toBe("Claimed"));
    await click(within(card).getByRole("button", { name: "See the proof" }));
    expect(within(card).getByTestId("verified-badge")).toBeTruthy();
  });
  it("stays ink without archive proof", async () => {
    const d = deps({ market: settled });
    d.chain.readPosition = vi.fn(async () => ({ contracts: 200, premiumPaid: 24_000_000n, lastNonce: 1n, closed: false }));
    render(<App deps={d} />);
    await waitFor(() => expect(screen.getAllByTestId("cover-card").some((x) => x.getAttribute("data-status") === "Monday mark final")).toBe(true));
    expect(document.querySelector("[data-testid=fall-marker]")!.getAttribute("data-verified")).toBe("false");
  });
});

describe("real two-step buy", () => {
  it("quotes in Review & confirm and signs once", async () => {
    const d = deps({ market: market() });
    render(<App deps={d} />);
    await click(await screen.findByTestId("buy-real"));
    expect(screen.getByTestId("buy-flow").getAttribute("data-step")).toBe("choose");
    expect(d.service.quote).not.toHaveBeenCalled();
    await click(screen.getByTestId("to-review"));
    const confirm = await screen.findByRole("button", { name: "Confirm and buy 200 contracts" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("review-premium").textContent).toMatch(/^\$24\.00/);
    await click(confirm);
    await waitFor(() => expect(d.wallet!.signTransaction).toHaveBeenCalledTimes(1));
  });
});

describe("New York times", () => {
  it("keeps 16:00 and 09:30 ET across the November clock change", async () => {
    const { demoWeekend, nextWeekend, fmtEtDay } = await import("../lib/cover");
    const now = Date.UTC(2026, 10, 3, 21); // Tue 3 Nov 2026
    const d = demoWeekend(now), n = nextWeekend(now);
    expect([fmtEtDay(d.friday), fmtEtDay(d.monday)]).toEqual(["Fri 30 Oct, 16:00 ET", "Mon 2 Nov, 09:30 ET"]);
    expect([fmtEtDay(n.friday), fmtEtDay(n.monday), fmtEtDay(n.buyBy)]).toEqual(["Fri 6 Nov, 16:00 ET", "Mon 9 Nov, 09:30 ET", "Sun 8 Nov, 17:50 ET"]);
  });
});
