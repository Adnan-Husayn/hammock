// Real-market (non-sandbox) runs on LiteSVM using only the service's own builders: the create-real-market encoder and
// create_market instruction, the keeper's submit_report and finalise instructions, and the quoter's signed quote.
//
// One signed regular fixture exists (29 Oct 2026, 1_793_280_669.4 s). A full single-market cycle with a buy and a
// real Monday report is impossible with it: buying needs FridayFinal (clock past F + 420 s) and must end by the buying
// close, which is at or before the Monday target, while the Monday report must lie within 5 s of the Monday target.
// With one timestamp both legs would have to sit within 5 s of each other. So each leg runs on real paths separately:
//   A. Friday report -> finalise_friday -> buy with a dealer quote -> no Monday report -> finalise_monday voids -> refund.
//   B. Friday report -> finalise_friday -> Monday report (same fixture, overlapping targets) -> finalise_monday settles.
// B's two legs carry the same price, so the gap is 0 and the payout 0; a paying claim is covered by the sandbox tests
// in settle_out.test.ts and needs a second signed fixture (a real Monday report) to cover on a real market.
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  startHarness, warpTo, fixturePayload, createScaledMint, createUsdcMint, mintUsdc, tokenBalance, sendTx, failed, SendResult,
} from "./harness";
import { createMarketInstruction, encodeMarketParams, type MarketParams } from "../service/src/sandbox";
import { finaliseInstruction, submitReportInstructions } from "../service/src/chain";
import { decodeMarket, positionPda, signQuote } from "../service/src/quote";

const FIX = 1_793_280_669; // fixture feed timestamp, whole seconds (.4 s after)
const UNIT = 1_000_000n;
const DEALER_START = 1_000_000_000n;
const logs = (r: SendResult) => (failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : r.logs().join("\n"));
const ok = (r: SendResult) => expect(failed(r), logs(r)).toBe(false);
const ix = (i: any) => new TransactionInstruction({ programId: new PublicKey(i.programId.toBase58()), data: Buffer.from(i.data), keys: i.keys.map((k: any) => ({ ...k, pubkey: new PublicKey(k.pubkey.toBase58()) })) });

async function setup(targets: { friday: number; monday: number; close: number }, maxContracts = 50) {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, DEALER_START);
  const quoteKey = Keypair.generate();
  const programId = h.program.programId;
  const p: MarketParams = {
    fridayTargetTs: BigInt(targets.friday), mondayTargetTs: BigInt(targets.monday), buyingCloseTs: BigInt(targets.close),
    fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10, maxContracts,
    quoteKey: quoteKey.publicKey, sandbox: false, demoAuthority: PublicKey.default, mode: "gap",
  };
  const { market, ix: create } = createMarketInstruction(programId, h.payer.publicKey, usdc, nvdax, p.fridayTargetTs, encodeMarketParams(p));
  const createIx = ix(create);
  createIx.keys[8].pubkey = dealerUsdc; // the harness funds a plain token account, not the dealer's ATA
  await warpTo(h.context, targets.friday - 7200);
  ok(sendTx(h.context, h.payer, [createIx]));
  const read = () => decodeMarket(Buffer.from(h.context.getAccount(market)!.data));
  return { h, usdc, nvdax, dealerUsdc, quoteKey, programId, market, read };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function report(c: Ctx, leg: "friday" | "monday", who: Keypair) {
  c.h.context.airdrop(who.publicKey, 1_000_000_000n);
  ok(sendTx(c.h.context, who, submitReportInstructions(c.programId, who.publicKey, c.market, leg, fixturePayload("regular-2026-10-29")).map(ix)));
}

async function finalise(c: Ctx, leg: "friday" | "monday", submitterUsdc: PublicKey) {
  const caller = Keypair.generate(); // permissionless
  c.h.context.airdrop(caller.publicKey, 1_000_000_000n);
  ok(sendTx(c.h.context, caller, [ix(finaliseInstruction(c.programId, caller.publicKey, c.market, c.read(), leg, submitterUsdc, c.dealerUsdc))]));
}

describe("real market end to end on LiteSVM", () => {
  it("A: Friday report, finalise_friday, buy on a dealer quote, no Monday report, void, refund", async () => {
    const monday = FIX + 66 * 3600;
    const c = await setup({ friday: FIX + 4, monday, close: monday - 3600 * 15 - 41 * 60 }); // close 15 h 41 min before Monday, as Sunday 17:50 ET is before 09:31:30 ET

    await warpTo(c.h.context, FIX + 4);
    const submitter = Keypair.generate();
    await report(c, "friday", submitter);
    expect(c.read().friday!.price).toBe(21_430_043n);
    const subUsdc = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    await warpTo(c.h.context, FIX + 4 + 421);
    await finalise(c, "friday", subUsdc);
    expect(c.read().state).toBe("FridayFinal");
    expect(tokenBalance(c.h.context, subUsdc)).toBe(100_000n);

    // Buy 10 contracts at 0.12 USDC on a quote signed with the service's signQuote.
    const buyer = Keypair.generate();
    c.h.context.airdrop(buyer.publicKey, 1_000_000_000n);
    const buyerUsdc = await mintUsdc(c.h.context, c.usdc, buyer.publicKey, 100_000_000n);
    const now = BigInt(c.h.context.getClock().unixTimestamp);
    const q = signQuote({ market: c.market, buyer: buyer.publicKey, contracts: 10, premiumPerContract: 120_000n, expiry: now + 60n, nonce: 1n }, c.quoteKey);
    const mk = c.read();
    const buy = await c.h.program.methods.buy().accounts({
      buyer: buyer.publicKey, market: c.market, position: positionPda(c.programId, c.market, buyer.publicKey),
      vaultAuthority: PublicKey.findProgramAddressSync([Buffer.from("vault"), c.market.toBuffer()], c.programId)[0],
      usdcMint: c.usdc, escrow: mk.escrow, collateralReserve: mk.collateralReserve, buyerUsdc,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    }).instruction();
    ok(sendTx(c.h.context, buyer, [ix(q.instruction), buy]));
    expect(tokenBalance(c.h.context, buyerUsdc)).toBe(100_000_000n - 1_200_000n);
    expect(tokenBalance(c.h.context, mk.escrow)).toBe(10n * UNIT);
    expect(c.read().contractsSold).toBe(10);

    // No eligible Monday report (the one fixture is 66 h too early): finalise_monday voids after the window.
    await warpTo(c.h.context, monday + 421);
    await finalise(c, "monday", c.dealerUsdc);
    expect(c.read().state).toBe("Voided");

    const refund = await c.h.program.methods.refund().accounts({
      owner: buyer.publicKey, market: c.market, position: positionPda(c.programId, c.market, buyer.publicKey),
      vaultAuthority: PublicKey.findProgramAddressSync([Buffer.from("vault"), c.market.toBuffer()], c.programId)[0],
      usdcMint: c.usdc, escrow: mk.escrow, ownerUsdc: buyerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    ok(sendTx(c.h.context, buyer, [refund]));
    expect(tokenBalance(c.h.context, buyerUsdc)).toBe(100_000_000n); // premium back
    expect(tokenBalance(c.h.context, mk.escrow)).toBe(0n);
    // Dealer: paid the Friday bounty, everything else came back.
    expect(DEALER_START - tokenBalance(c.h.context, c.dealerUsdc)).toBe(100_000n);
  });

  it("B: Friday report, finalise_friday, Monday report, finalise_monday settles with both bounties paid", async () => {
    // Targets straddle the fixture so it is eligible for both legs: Friday FIX - 4, Monday FIX + 3, buying close at
    // the Monday target. finalise_friday is allowed from FIX + 417 and the Monday window closes at FIX + 423, so the
    // Monday report fits between. Buying has closed by then, so this market has no buyers.
    const c = await setup({ friday: FIX - 4, monday: FIX + 3, close: FIX + 3 });
    await warpTo(c.h.context, FIX - 4);
    const fri = Keypair.generate();
    await report(c, "friday", fri);
    const friUsdc = await mintUsdc(c.h.context, c.usdc, fri.publicKey, 0n);
    await warpTo(c.h.context, FIX - 4 + 421);
    await finalise(c, "friday", friUsdc);
    expect(c.read().state).toBe("FridayFinal");

    const mon = Keypair.generate();
    await report(c, "monday", mon);
    expect(c.read().monday!.submitter.equals(mon.publicKey)).toBe(true);
    const monUsdc = await mintUsdc(c.h.context, c.usdc, mon.publicKey, 0n);
    await warpTo(c.h.context, FIX + 3 + 421);
    await finalise(c, "monday", monUsdc);
    const m = c.read();
    expect(m.state).toBe("MondayFinal");
    expect(m.monday!.price).toBe(m.friday!.price); // same price both legs: no fall, nothing to claim
    expect(tokenBalance(c.h.context, friUsdc)).toBe(100_000n);
    expect(tokenBalance(c.h.context, monUsdc)).toBe(100_000n);
    expect(tokenBalance(c.h.context, m.collateralReserve)).toBe(0n);
    expect(tokenBalance(c.h.context, m.bountyReserve)).toBe(0n);
    expect(DEALER_START - tokenBalance(c.h.context, c.dealerUsdc)).toBe(200_000n);
  });
});
