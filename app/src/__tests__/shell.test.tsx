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
    expect(screen.getByTestId("card-run-demo").textContent).toBe("Run a demo weekend");
    await click(screen.getByTestId("card-run-demo"));
    expect(screen.getByTestId("buy-flow").getAttribute("data-step")).toBe("choose");
    await click(screen.getByRole("button", { name: "Cancel" }));
    const landing = screen.getByTestId("landing");
    expect(screen.getByTestId("market-closed").textContent).toBe("Stock market closed for 65h 30m. Token still trades. A Monday mark over 1% below Friday's pays you in USDC, up to $200.");
    expect(within(landing).getAllByRole("button").map((b) => b.textContent)).toEqual(["Run a demo weekend", "See how cover works"]);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(screen.queryByTestId("ledger")).toBeNull();
  });
});

describe("two-step buy", () => {
  it("goes Choose cover, then Review & confirm, then the card shows Cover active", async () => {
    await runDemoToActive();
    const flow = screen.getByTestId("buy-flow");
    expect(screen.getAllByTestId("cover-card").length).toBe(1);
    expect(screen.getByTestId("cover-card").contains(flow)).toBe(true);
    expect(flow.getAttribute("data-step")).toBe("choose");
    expect(within(flow).getByRole("heading").textContent).toBe("Choose cover");
    expect(within(flow).getByRole("group", { name: "Cover stock" })).toBeTruthy();
    expect((screen.getByTestId("holding-input") as HTMLInputElement).value).toBe("5000");
    expect((screen.getByTestId("cover-input") as HTMLInputElement).value).toBe("200");
    await click(screen.getByTestId("to-review"));
    expect(flow.getAttribute("data-step")).toBe("review");
    expect(within(flow).getByRole("heading").textContent).toBe("Review & confirm");
    expect(screen.getByTestId("review-lead").textContent).toBe("At a 3% fall: -$73.91 with cover, -$150.00 without.");
    expect(screen.getByTestId("review-cap").textContent).toBe("Payout stops at $200.00 at a 5% fall. Past 5%, your net loss grows again.");
    expect(screen.getByTestId("review").textContent).not.toMatch(/not covered/);
    const review = screen.getByTestId("review").textContent!;
    for (const k of ["Premium", "Payout cap", "Band", "Monday mark", "Quote expiry"]) expect(review).toContain(k);
    expect(screen.getByTestId("review-premium").textContent).toMatch(/^\$23\.91/);
    const rows = within(screen.getByTestId("outcomes")).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows).toEqual(["0%-$23.91$0.00", "3%-$73.91-$150.00", "8%-$223.91-$400.00"]);
    await click(screen.getByTestId("confirm-demo"));
    expect(screen.queryByTestId("buy-flow")).toBeNull();
    expect(screen.getByTestId("cover-status").textContent).toBe("Cover active");
    expect(screen.getByTestId("time-tag").textContent).toBe("Demo: the 65h 30m weekend runs in about 4 seconds");
    expect(screen.getByTestId("sized-note").textContent).toBe("Cover stays at 200 contracts even if your token balance changes.");
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
    expect(within(card).getByTestId("settled-lines").textContent).toBe("Monday fall -3%");
    expect(within(card).getByTestId("sum-line").textContent).toBe("stock -$150.00 + payout +$100.00 - premium $23.91 = net -$73.91");
    expect(within(card).getByTestId("net-loss").textContent).toBe("-$73.91");
    expect(within(card).getByTestId("uncovered").textContent).toBe("without cover -$150.00");
    const primaries = card.querySelectorAll("button.primary");
    expect(primaries.length).toBe(1);
    expect(primaries[0].textContent).toBe("Claim $100.00 USDC");
    // demo marker is never blue, but the settlement reads on the line
    expect(card.querySelector("[data-testid=fall-marker]")!.getAttribute("data-verified")).toBe("false");
    expect(card.querySelector("[data-testid=mark-label]")!.textContent).toBe("Monday mark (demo) 3.00%");
    expect(card.textContent).not.toMatch(/Payout starts at 1%|Full payout at 5%/);
    expect(within(card).getByTestId("marks").textContent).toContain("Demo: the 65h 30m weekend runs in about 4 seconds");
    expect(within(card).getByTestId("cover-status").textContent).toBe("Demo mark final");
    expect(within(card).getByTestId("what-now").textContent).toContain("Monday mark is in. Claim the $100.00 demo payout. Demo USDC only, no real funds.");
    const row = within(card).getByTestId("action-row");
    expect(within(row).getByTestId("source-line").textContent).toBe("Demo result, no signed price proof");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Claim $100.00 USDC", "Export receipt"]);
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
    try {
    render(<App deps={deps({ market: null, wallet: false })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await click(screen.getByTestId("run-demo"));
    await click(screen.getByTestId("to-review"));
    await click(screen.getByTestId("confirm-demo"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("cover-status").textContent).toBe("Demo mark final");
    } finally { vi.useRealTimers(); }
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
    expect(within(ledger).getByTestId("ledger-row").querySelector(".ledger-status")!.textContent).toBe("Demo mark final");
    expect(screen.getByTestId("how").textContent).toContain("Past 5%, the payout stays at $1.00 and your net loss grows again.");
    expect(document.body.textContent).not.toMatch(/not covered/);
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
    expect(within(card).getByTestId("cover-status").textContent).toBe("Monday mark final");
    expect(within(card).getByTestId("source-line").textContent).toBe("Verified Pyth result, receipt available");
    expect(within(card).getByTestId("source-line").classList.contains("is-verified")).toBe(true);
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
  it("keeps 16:00 and 09:30 ET across the clock change, and demo uses the upcoming weekend", async () => {
    const { demoWeekend, nextWeekend, fmtEtDay } = await import("../lib/cover");
    const now = Date.UTC(2026, 10, 3, 21); // Tue 3 Nov 2026
    const d = demoWeekend(now), n = nextWeekend(now);
    expect([fmtEtDay(d.friday), fmtEtDay(d.monday)]).toEqual(["Fri 6 Nov, 16:00 ET", "Mon 9 Nov, 09:30 ET"]);
    const early = nextWeekend(Date.UTC(2026, 9, 27, 12));
    expect([fmtEtDay(early.friday), fmtEtDay(early.monday)]).toEqual(["Fri 30 Oct, 16:00 ET", "Mon 2 Nov, 09:30 ET"]);
    expect([fmtEtDay(n.friday), fmtEtDay(n.monday), fmtEtDay(n.buyBy)]).toEqual(["Fri 6 Nov, 16:00 ET", "Mon 9 Nov, 09:30 ET", "Sun 8 Nov, 17:50 ET"]);
  });
});

describe("voided copy", () => {
  it("says Refunded once the premium is back", async () => {
    const { whatNow } = await import("../lib/cover");
    const c = { id: "v", kind: "real" as const, symbol: "NVDA", holding: 5000, contracts: 200, premium: 24, fridayPrice: 180, fridayAt: null, mondayAt: null, mondayPrice: null, status: "Voided" as const };
    expect(whatNow({ ...c, refunded: true })).toMatch(/^Refunded\./);
    expect(whatNow(c)).not.toMatch(/refunded/i);
    render(<CoverCard c={{ ...c, refunded: true }} holdingLabel="Your holding" />);
    expect(screen.getByTestId("void-line").textContent).toContain("Refunded: premium $24.00.");
    expect(screen.getByTestId("void-line").textContent).not.toMatch(/comes back/);
  });
});

describe("ledger on load", () => {
  it("drops demo entries that never reached Claimed or Expired", async () => {
    const { loadLedger } = await import("../lib/ledger");
    const base = { kind: "demo", symbol: "NVDA", holding: 5000, contracts: 200, premium: 23.91, fridayPrice: 180, fridayAt: null, mondayAt: null, mondayPrice: null };
    localStorage.setItem(LEDGER_KEY, JSON.stringify([
      { ...base, id: "a", status: "Cover active" }, { ...base, id: "b", status: "Monday mark final" },
      { ...base, id: "c", status: "Claimed" }, { ...base, id: "d", status: "Expired, no payout" },
    ]));
    expect(loadLedger().map((c) => c.id)).toEqual(["c", "d"]);
    render(<App deps={deps({ market: null, wallet: false })} />);
    expect(screen.getAllByTestId("ledger-row").map((r) => r.getAttribute("data-status"))).toEqual(["Claimed", "Expired, no payout"]);
  });
});
