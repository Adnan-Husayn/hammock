import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Ed25519Program, Transaction } from "@solana/web3.js";
import App from "../App";
import { LockedView } from "../components/LockedView";
import { ProofScreen } from "../components/ProofScreen";
import { Sandbox } from "../components/Sandbox";
import { deps, market, NOW, OPEN, pk } from "./fixtures";

const settled = market({
  state: "MondayFinal", contractsSold: 200, payoutPerContract: 250_000n, settledAt: BigInt(NOW / 1000),
  monday: { price: 17_640_000n, feedTsUs: BigInt(NOW) * 1000n, submitter: pk() },
});

describe("copy", () => {
  const states = [null, market({ state: "Created", friday: null }), market(), market({ buyingClosed: true }), settled, market({ state: "Voided" })];
  for (const m of states) {
    it(`no "open" in state ${m?.state ?? "none"}${m?.buyingClosed ? " (locked)" : ""}`, async () => {
      const { container } = render(<App deps={deps({ market: m })} />);
      await screen.findByTestId("state-card");
      expect(container.textContent).not.toMatch(OPEN);
    });
  }

  it("locked view and proof screen carry no \"open\"", async () => {
    const d = deps({ market: settled });
    d.service.archive = async (_m, leg) => [{
      feedTsUs: leg === "friday" ? settled.friday!.feedTsUs.toString() : settled.monday!.feedTsUs.toString(), timestampUs: "0",
      price: "0", exponent: -5, confidence: "1200", publishers: 21, session: "regular", hash: "ab",
    }];
    const a = render(<LockedView deps={d} market={pk()} info={market({ buyingClosed: true })} />);
    await screen.findByText(/estimate/i);
    expect(a.container.textContent).not.toMatch(OPEN);
    a.unmount();
    const b = render(<ProofScreen deps={d} market={pk()} info={settled} />);
    await screen.findAllByText("21");
    for (const label of ["Signed price", "Session", "Timestamp", "Publishers", "Confidence", "Escrow at finalisation, kept for payouts"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(b.container.textContent).not.toMatch(OPEN);
  });

  it("sandbox shows Ring the Monday bell after a buy", async () => {
    const d = deps({ market: market({ sandbox: true }) });
    const { container } = render(<Sandbox deps={d} symbol="NVDA" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /gap mode/i })));
    await screen.findByText("Total premium"); // the buy button enables once the quote is in
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^buy/i })));
    await screen.findByRole("button", { name: "Ring the Monday bell" });
    expect(container.textContent).not.toMatch(OPEN);
    // Sandbox: the unsigned transaction goes to the relay first, Ed25519 at index 0, buy at index 1.
    const sent = Transaction.from(Buffer.from((d.service.relay as any).mock.calls[0][0], "base64"));
    expect(sent.instructions[0].programId.equals(Ed25519Program.programId)).toBe(true);
    expect(sent.instructions[1].programId.equals(d.programId)).toBe(true);
    expect(d.wallet!.signTransaction).toHaveBeenCalledTimes(1);
  });
});
