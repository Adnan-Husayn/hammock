import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { BuyPanel } from "../components/BuyPanel";
import { deps, market, NOW, pk } from "./fixtures";

const CASES = [
  ["none", null],
  ["created", market({ state: "Created", friday: null })],
  ["buying", market()],
  ["locked", market({ buyingClosed: true })],
  ["settled", market({ state: "MondayFinal", monday: { price: 17_640_000n, feedTsUs: 1n, submitter: pk() }, payoutPerContract: 250_000n, settledAt: BigInt(NOW / 1000) })],
  ["voided", market({ state: "Voided" })],
] as const;

describe("market states", () => {
  for (const [name, m] of CASES) {
    it(`${name}: renders a state card and Try the sandbox`, async () => {
      render(<App deps={deps({ market: m })} />);
      const card = await screen.findByTestId("state-card");
      expect(card.getAttribute("data-state")).toBe(name);
      expect(screen.getByRole("button", { name: "Try the sandbox" })).toBeTruthy();
    });
  }
});

describe("buy panel", () => {
  it("USDC below total premium shows Not enough USDC and requests no signature", async () => {
    const d = deps({ market: market(), usdc: 10_000_000n }); // 10 USDC < 24 USDC premium
    render(<BuyPanel deps={d} market={pk()} info={market()} contracts={200} />);
    await screen.findByText("Not enough USDC");
    const button = screen.getByRole("button", { name: /buy/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(d.wallet!.signTransaction).not.toHaveBeenCalled());
    expect(d.service.relay).not.toHaveBeenCalled();
  });
});
