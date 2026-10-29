import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import {
  Harness,
  startHarness,
  warpTo,
  fixturePayload,
  createScaledMint,
  createUsdcMint,
  mintUsdc,
  tokenBalance,
  sendTx,
  failed,
  SendResult,
  LAZER_PROGRAM_ID,
  LAZER_STORAGE,
  LAZER_TREASURY,
} from "./harness";

const MONDAY = 1_793_280_672; // fixture feedUpdateTimestamp is 1_793_280_669.4 s
const FRIDAY = MONDAY - 66 * 3600;
const REGULAR = "regular-2026-10-29";
// Position of the envelope inside submit_report data: 8 discriminator + 1 leg + 4 vec length.
const ENVELOPE_OFFSET = 13;

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, 1_000_000_000n);
  return { h, usdc, nvdax, dealerUsdc };
}

function pda(h: Harness, seeds: Buffer[]) {
  return PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
}

function i64le(v: number) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
}

function addresses(c: Ctx, fridayTs: number) {
  const market = pda(c.h, [Buffer.from("market"), c.h.payer.publicKey.toBuffer(), i64le(fridayTs)]);
  return {
    market,
    vaultAuthority: pda(c.h, [Buffer.from("vault"), market.toBuffer()]),
    escrow: pda(c.h, [Buffer.from("escrow"), market.toBuffer()]),
    collateralReserve: pda(c.h, [Buffer.from("collateral"), market.toBuffer()]),
    bountyReserve: pda(c.h, [Buffer.from("bounty"), market.toBuffer()]),
  };
}

function params(over: Record<string, unknown> = {}) {
  return {
    fridayTargetTs: new BN(FRIDAY),
    mondayTargetTs: new BN(MONDAY),
    buyingCloseTs: new BN(MONDAY - 3600),
    bandLowerBps: 100,
    bandUpperBps: 500,
    fridayConfCapBps: 10,
    mondayConfCapBps: 20,
    minPublishers: 10,
    maxContracts: 50,
    bountyPerLeg: new BN(100_000),
    dealerQuoteKey: Keypair.generate().publicKey,
    sandbox: false,
    demoAuthority: PublicKey.default,
    sandboxMode: { gap: {} },
    ...over,
  };
}

async function createIx(c: Ctx, p: ReturnType<typeof params>) {
  const a = addresses(c, (p.fridayTargetTs as BN).toNumber());
  const ix = await c.h.program.methods
    .createMarket(p)
    .accounts({
      dealer: c.h.payer.publicKey,
      market: a.market,
      vaultAuthority: a.vaultAuthority,
      usdcMint: c.usdc,
      nvdaxMint: c.nvdax,
      escrow: a.escrow,
      collateralReserve: a.collateralReserve,
      bountyReserve: a.bountyReserve,
      dealerUsdc: c.dealerUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, a };
}

async function createMarket(c: Ctx, over: Record<string, unknown> = {}, at?: number) {
  const p = params(over);
  await warpTo(c.h.context, at ?? (p.fridayTargetTs as BN).toNumber() - 7200);
  const { ix, a } = await createIx(c, p);
  const r = sendTx(c.h.context, c.h.payer, [ix]);
  return { r, a };
}

async function mustCreate(c: Ctx, over: Record<string, unknown> = {}) {
  const { r, a } = await createMarket(c, over);
  expect(failed(r), failed(r) ? logs(r) : "").toBe(false);
  return a;
}

function logs(r: SendResult) {
  return failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : r.logs().join("\n");
}

function expectError(r: SendResult, name: string) {
  expect(failed(r), "expected the transaction to fail").toBe(true);
  expect(logs(r)).toContain(`Error Code: ${name}.`);
}

async function fetchMarket(c: Ctx, market: PublicKey) {
  const acc = c.h.context.getAccount(market)!;
  return c.h.program.coder.accounts.decode("market", Buffer.from(acc.data)) as any;
}

/** Test seam: finalise_friday arrives in Task 7, so tests move a real market to FridayFinal directly. */
async function forceFridayFinal(c: Ctx, market: PublicKey) {
  const acc = c.h.context.getAccount(market)!;
  const m = await fetchMarket(c, market);
  m.state = { fridayFinal: {} };
  const enc = await c.h.program.coder.accounts.encode("market", m);
  const data = Buffer.alloc(acc.data.length);
  enc.copy(data);
  c.h.context.setAccount(market, { ...acc, data });
}

async function reportIxs(c: Ctx, market: PublicKey, submitter: PublicKey, leg: "friday" | "monday", msg: Buffer) {
  const ix = await c.h.program.methods
    .submitReport({ [leg]: {} } as any, msg)
    .accounts({
      submitter,
      market,
      lazerProgram: LAZER_PROGRAM_ID,
      lazerStorage: LAZER_STORAGE,
      lazerTreasury: LAZER_TREASURY,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  return { ed: createEd25519Instruction(msg, 1, ENVELOPE_OFFSET), ix };
}

async function submit(c: Ctx, market: PublicKey, leg: "friday" | "monday", who?: Keypair) {
  const signer = who ?? c.h.payer;
  if (who) c.h.context.airdrop(who.publicKey, 1_000_000_000n);
  const { ed, ix } = await reportIxs(c, market, signer.publicKey, leg, fixturePayload(REGULAR));
  return sendTx(c.h.context, signer, [ed, ix]);
}

async function sandboxPriceIx(c: Ctx, market: PublicKey, authority: PublicKey, leg: "friday" | "monday", price: number) {
  return c.h.program.methods
    .submitSandboxPrice({ [leg]: {} } as any, new BN(price))
    .accounts({ demoAuthority: authority, market })
    .instruction();
}

describe("create_market", () => {
  it("funds collateral with max_contracts * 1_000_000 and bounty with 2 * bounty", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    expect(tokenBalance(c.h.context, a.collateralReserve)).toBe(50_000_000n);
    expect(tokenBalance(c.h.context, a.bountyReserve)).toBe(200_000n);
    expect(tokenBalance(c.h.context, a.escrow)).toBe(0n);
    const m = await fetchMarket(c, a.market);
    expect(m.feedId).toBe(1314);
    expect(m.exponent).toBe(-5);
    expect(m.eligibilityHalfWindowUs.toNumber()).toBe(5_000_000);
    expect(m.submissionWindowUs.toNumber()).toBe(420_000_000);
    expect(m.state).toEqual({ created: {} });
    expect(m.friday).toBeNull();
    expect(m.monday).toBeNull();
  });

  it("rejects a real market created under 3_600 s before the Friday target", async () => {
    const c = await setup();
    const { r } = await createMarket(c, {}, FRIDAY - 3599);
    expectError(r, "CreatedTooLate");
  });

  it("rejects an inverted or empty band", async () => {
    const c = await setup();
    expectError((await createMarket(c, { bandLowerBps: 500, bandUpperBps: 100 })).r, "InvalidParams");
    expectError((await createMarket(c, { bandLowerBps: 100, bandUpperBps: 100 })).r, "InvalidParams");
    expectError((await createMarket(c, { bandLowerBps: 0, bandUpperBps: 500 })).r, "InvalidParams");
    expectError((await createMarket(c, { bandLowerBps: 100, bandUpperBps: 10_001 })).r, "InvalidParams");
  });

  it("rejects a real market that names a demo authority", async () => {
    const c = await setup();
    expectError((await createMarket(c, { demoAuthority: Keypair.generate().publicKey })).r, "InvalidParams");
  });
});

describe("submit_report", () => {
  it("stores the regular fixture as the Monday candidate with its submitter, and keeps it on a tie", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    await forceFridayFinal(c, a.market);
    await warpTo(c.h.context, MONDAY);
    const first = Keypair.generate();
    const fee0 = c.h.context.getBalance(LAZER_TREASURY)!;
    const r = await submit(c, a.market, "monday", first);
    expect(failed(r), logs(r)).toBe(false);
    // The Lazer verifier ran by CPI and charged its 1-lamport fee.
    expect(logs(r)).toContain(`Program ${LAZER_PROGRAM_ID.toBase58()} success`);
    expect(c.h.context.getBalance(LAZER_TREASURY)! - fee0).toBe(1n);
    let m = await fetchMarket(c, a.market);
    expect(m.monday.price.toNumber()).toBe(21_430_043);
    expect(m.monday.feedTsUs.toString()).toBe("1793280669400000");
    expect(m.monday.submitter.toBase58()).toBe(first.publicKey.toBase58());

    const second = Keypair.generate();
    const r2 = await submit(c, a.market, "monday", second);
    expect(failed(r2), logs(r2)).toBe(false);
    m = await fetchMarket(c, a.market);
    expect(m.monday.submitter.toBase58()).toBe(first.publicKey.toBase58());
  });

  it("fails WrongInstructionLayout when the Ed25519 instruction is at index 1", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    await forceFridayFinal(c, a.market);
    await warpTo(c.h.context, MONDAY);
    const msg = fixturePayload(REGULAR);
    const { ix } = await reportIxs(c, a.market, c.h.payer.publicKey, "monday", msg);
    const ed = createEd25519Instruction(msg, 0, ENVELOPE_OFFSET);
    expectError(sendTx(c.h.context, c.h.payer, [ix, ed]), "WrongInstructionLayout");
  });

  it("fails WrongInstructionLayout when the signed envelope differs from the argument", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    await forceFridayFinal(c, a.market);
    await warpTo(c.h.context, MONDAY);
    const msg = fixturePayload(REGULAR);
    const { ix } = await reportIxs(c, a.market, c.h.payer.publicKey, "monday", msg);
    // An Ed25519 instruction carrying its own copy of the message, pointing at itself.
    const own = createEd25519Instruction(msg, 0, 16);
    const ed = new TransactionInstruction({ programId: own.programId, keys: [], data: Buffer.concat([own.data.subarray(0, 16), msg]) });
    expectError(sendTx(c.h.context, c.h.payer, [ed, ix]), "WrongInstructionLayout");
  });

  it("fails WindowClosed after T + 7 min", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    await forceFridayFinal(c, a.market);
    await warpTo(c.h.context, MONDAY + 7 * 60 + 1);
    expectError(await submit(c, a.market, "monday"), "WindowClosed");
  });

  it("fails WrongState for a Monday report before FridayFinal", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    await warpTo(c.h.context, MONDAY);
    expectError(await submit(c, a.market, "monday"), "WrongState");
  });

  it("fails WrongState for a Friday report after FridayFinal", async () => {
    const c = await setup();
    const friday = MONDAY - 1;
    const a = await mustCreate(c, { fridayTargetTs: new BN(friday), mondayTargetTs: new BN(MONDAY + 3 * 86400), buyingCloseTs: new BN(MONDAY + 3 * 86400 - 3600) });
    await forceFridayFinal(c, a.market);
    await warpTo(c.h.context, friday);
    expectError(await submit(c, a.market, "friday"), "WrongState");
  });

  it("rejects submit_sandbox_price on a real market", async () => {
    const c = await setup();
    const a = await mustCreate(c);
    const ix = await sandboxPriceIx(c, a.market, c.h.payer.publicKey, "friday", 21_000_000);
    expectError(sendTx(c.h.context, c.h.payer, [ix]), "NotSandbox");
  });
});

describe("sandbox", () => {
  async function sandbox() {
    const c = await setup();
    const demo = Keypair.generate();
    c.h.context.airdrop(demo.publicKey, 1_000_000_000n);
    const now = Number(c.h.context.getClock().unixTimestamp);
    const a = await mustCreate(c, {
      fridayTargetTs: new BN(now + 10),
      mondayTargetTs: new BN(now + 700),
      buyingCloseTs: new BN(now + 610),
      sandbox: true,
      demoAuthority: demo.publicKey,
    });
    return { c, a, demo };
  }

  it("rejects submit_report", async () => {
    const { c, a } = await sandbox();
    expectError(await submit(c, a.market, "friday"), "SandboxMarket");
  });

  it("rejects a price from anyone but the demo authority", async () => {
    const { c, a } = await sandbox();
    const ix = await sandboxPriceIx(c, a.market, c.h.payer.publicKey, "friday", 21_000_000);
    expectError(sendTx(c.h.context, c.h.payer, [ix]), "WrongAuthority");
  });

  it("moves straight to FridayFinal on the Friday price", async () => {
    const { c, a, demo } = await sandbox();
    const ix = await sandboxPriceIx(c, a.market, demo.publicKey, "friday", 21_000_000);
    const r = sendTx(c.h.context, demo, [ix]);
    expect(failed(r), logs(r)).toBe(false);
    const m = await fetchMarket(c, a.market);
    expect(m.state).toEqual({ fridayFinal: {} });
    expect(m.friday.price.toNumber()).toBe(21_000_000);
    expect(m.friday.submitter.toBase58()).toBe(demo.publicKey.toBase58());
  });

  it("closes buying on the Monday price", async () => {
    const { c, a, demo } = await sandbox();
    sendTx(c.h.context, demo, [await sandboxPriceIx(c, a.market, demo.publicKey, "friday", 21_000_000)]);
    const r = sendTx(c.h.context, demo, [await sandboxPriceIx(c, a.market, demo.publicKey, "monday", 20_000_000)]);
    expect(failed(r), logs(r)).toBe(false);
    const m = await fetchMarket(c, a.market);
    expect(m.buyingClosed).toBe(true);
    expect(m.monday.price.toNumber()).toBe(20_000_000);
    expect(m.state).toEqual({ fridayFinal: {} });
  });
});

