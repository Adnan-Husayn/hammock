import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import {
  Harness, startHarness, warpTo, createScaledMint, scheduleMultiplier, createUsdcMint, mintUsdc, tokenBalance, sendTx,
  failed, SendResult, fixturePayload, LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY,
} from "./harness";

const FRIDAY = 1_793_280_672;
const MONDAY = FRIDAY + 66 * 3600;
const UNIT = 1_000_000n;
const FRIDAY_PRICE = 20_000_000;

const pda = (h: Harness, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
function i64le(v: number | bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; }
function u64le(v: number | bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function u32le(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
const logs = (r: SendResult) => (failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : r.logs().join("\n"));
function expectError(r: SendResult, name: string) {
  expect(failed(r), "expected the transaction to fail").toBe(true);
  expect(logs(r)).toContain(`Error Code: ${name}.`);
}

async function setup(sandbox = true) {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, 1_000_000_000n);
  const quoteKey = Keypair.generate();
  const demo = Keypair.generate();
  h.context.airdrop(demo.publicKey, 1_000_000_000n);
  const market = pda(h, [Buffer.from("market"), h.payer.publicKey.toBuffer(), u32le(1314), i64le(FRIDAY)]);
  const a = {
    market,
    vaultAuthority: pda(h, [Buffer.from("vault"), market.toBuffer()]),
    escrow: pda(h, [Buffer.from("escrow"), market.toBuffer()]),
    collateralReserve: pda(h, [Buffer.from("collateral"), market.toBuffer()]),
    bountyReserve: pda(h, [Buffer.from("bounty"), market.toBuffer()]),
  };
  const params = {
    feedId: 1314, exponent: -5,
    fridayTargetTs: new BN(FRIDAY), mondayTargetTs: new BN(MONDAY), buyingCloseTs: new BN(MONDAY - 3600),
    bandLowerBps: 100, bandUpperBps: 500, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10,
    maxContracts: 50, bountyPerLeg: new BN(100_000), dealerQuoteKey: quoteKey.publicKey,
    sandbox, demoAuthority: sandbox ? demo.publicKey : PublicKey.default, sandboxMode: { gap: {} },
  };
  await warpTo(h.context, FRIDAY - 7200);
  const ix = await h.program.methods.createMarket(params).accounts({
    dealer: h.payer.publicKey, market, vaultAuthority: a.vaultAuthority, usdcMint: usdc, stockMint: nvdax,
    escrow: a.escrow, collateralReserve: a.collateralReserve, bountyReserve: a.bountyReserve,
    dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  const r = sendTx(h.context, h.payer, [ix]);
  expect(failed(r), logs(r)).toBe(false);
  const c = { h, usdc, nvdax, dealerUsdc, quoteKey, demo, a, now: FRIDAY - 7200 };
  if (sandbox) await sandboxPrice(c, "friday", FRIDAY_PRICE);
  return c;
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function sandboxPrice(c: Ctx, leg: "friday" | "monday", price: number) {
  const ix = await c.h.program.methods.submitSandboxPrice({ [leg]: {} } as any, new BN(price))
    .accounts({ demoAuthority: c.demo.publicKey, market: c.a.market }).instruction();
  const r = sendTx(c.h.context, c.demo, [ix]);
  expect(failed(r), logs(r)).toBe(false);
}

async function buy(c: Ctx, contracts: number, premium: bigint) {
  const kp = Keypair.generate();
  c.h.context.airdrop(kp.publicKey, 1_000_000_000n);
  const usdc = await mintUsdc(c.h.context, c.usdc, kp.publicKey, 100_000_000n);
  const msg = Buffer.concat([
    Buffer.from("MGCQ"), c.a.market.toBuffer(), kp.publicKey.toBuffer(),
    u32le(contracts), u64le(premium), i64le(c.now + 60), u64le(1n),
  ]);
  const position = pda(c.h, [Buffer.from("position"), c.a.market.toBuffer(), kp.publicKey.toBuffer()]);
  const ix = await c.h.program.methods.buy().accounts({
    buyer: kp.publicKey, market: c.a.market, position, vaultAuthority: c.a.vaultAuthority,
    usdcMint: c.usdc, escrow: c.a.escrow, collateralReserve: c.a.collateralReserve, buyerUsdc: usdc,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).instruction();
  const ed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: c.quoteKey.secretKey, message: msg });
  const r = sendTx(c.h.context, kp, [ed, ix]);
  expect(failed(r), logs(r)).toBe(false);
  return { kp, usdc, position };
}

async function finaliseIx(c: Ctx, caller: PublicKey, submitterUsdc: PublicKey, dealerUsdc = c.dealerUsdc) {
  return c.h.program.methods.finaliseMonday().accounts({
    caller, market: c.a.market, vaultAuthority: c.a.vaultAuthority, usdcMint: c.usdc, stockMint: c.nvdax,
    escrow: c.a.escrow, collateralReserve: c.a.collateralReserve, bountyReserve: c.a.bountyReserve,
    submitterUsdc, dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}

async function fetchMarket(c: Ctx) {
  return c.h.program.coder.accounts.decode("market", Buffer.from(c.h.context.getAccount(c.a.market)!.data)) as any;
}

async function stranger(c: Ctx) {
  const kp = Keypair.generate();
  c.h.context.airdrop(kp.publicKey, 1_000_000_000n);
  return kp;
}

const bal = (c: Ctx, acct: PublicKey) => tokenBalance(c.h.context, acct);


type Buyer = Awaited<ReturnType<typeof buy>>;
const DAY = 86_400;

async function settle(c: Ctx, mondayPrice: number, voidIt = false) {
  if (voidIt) await scheduleMultiplier(c.h.context, c.nvdax, 1.0025, c.now - 10);
  await sandboxPrice(c, "monday", mondayPrice);
  const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
  const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]);
  expect(failed(r), logs(r)).toBe(false);
}

async function settledAt(c: Ctx) {
  const t = Number((await fetchMarket(c)).settledAt);
  expect(t).toBe(Number(c.h.context.getClock().unixTimestamp));
  expect(t).toBeGreaterThan(0);
  return t;
}

function payoutAccounts(c: Ctx, b: Buyer, to: PublicKey = b.usdc) {
  return {
    owner: b.kp.publicKey, market: c.a.market, position: b.position, vaultAuthority: c.a.vaultAuthority,
    usdcMint: c.usdc, escrow: c.a.escrow, ownerUsdc: to, tokenProgram: TOKEN_PROGRAM_ID,
  };
}
async function claimIx(c: Ctx, b: Buyer, to?: PublicKey) { return c.h.program.methods.claim().accounts(payoutAccounts(c, b, to)).instruction(); }
async function refundIx(c: Ctx, b: Buyer, to?: PublicKey) { return c.h.program.methods.refund().accounts(payoutAccounts(c, b, to)).instruction(); }
async function sweepIx(c: Ctx, caller: PublicKey) {
  return c.h.program.methods.sweep().accounts({
    caller, market: c.a.market, vaultAuthority: c.a.vaultAuthority, usdcMint: c.usdc, escrow: c.a.escrow,
    dealerUsdc: c.dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
async function closeIx(c: Ctx, caller: PublicKey) {
  return c.h.program.methods.closeMarket().accounts({ caller, market: c.a.market, dealer: c.h.payer.publicKey }).instruction();
}
async function fetchPosition(c: Ctx, b: Buyer) {
  return c.h.program.coder.accounts.decode("position", Buffer.from(c.h.context.getAccount(b.position)!.data)) as any;
}
const send = (c: Ctx, kp: Keypair, ix: any) => { c.h.context.expireBlockhash(); return sendTx(c.h.context, kp, [ix]); };

describe("claim", () => {
  it("pays contracts * payout into the owner's account and closes the position", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await buy(c, 4, 200_000n);
    await settle(c, 19_600_000);
    const before = bal(c, b.usdc);
    const r = send(c, b.kp, await claimIx(c, b));
    expect(failed(r), logs(r)).toBe(false);
    expect(bal(c, b.usdc) - before).toBe(2_500_000n);
    expect(bal(c, c.a.escrow)).toBe(4n * 250_000n);
    expect((await fetchPosition(c, b)).closed).toBe(true);
    expect((await fetchMarket(c)).openPositions).toBe(1);
  });

  it("a zero payout still closes the position", async () => {
    const c = await setup();
    const b = await buy(c, 5, 300_000n);
    await settle(c, 21_000_000);
    const before = bal(c, b.usdc);
    const r = send(c, b.kp, await claimIx(c, b));
    expect(failed(r), logs(r)).toBe(false);
    expect(bal(c, b.usdc)).toBe(before);
    expect((await fetchPosition(c, b)).closed).toBe(true);
    expect((await fetchMarket(c)).openPositions).toBe(0);
  });

  it("a second claim fails", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await buy(c, 4, 200_000n);
    await settle(c, 19_600_000);
    expect(failed(send(c, b.kp, await claimIx(c, b)))).toBe(false);
    expectError(send(c, b.kp, await claimIx(c, b)), "PositionClosed");
  });

  it("paying to another wallet's token account fails", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    const thief = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    expectError(send(c, b.kp, await claimIx(c, b, thief)), "InvalidMint");
  });

  it("another wallet cannot claim someone else's position", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    const other = await stranger(c);
    const otherUsdc = await mintUsdc(c.h.context, c.usdc, other.publicKey, 0n);
    const ix = await c.h.program.methods.claim().accounts({ ...payoutAccounts(c, b, otherUsdc), owner: other.publicKey }).instruction();
    expect(failed(send(c, other, ix))).toBe(true);
  });

  it("fails before settlement", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    expectError(send(c, b.kp, await claimIx(c, b)), "WrongState");
  });
});

describe("refund", () => {
  it("pays premium_paid in Voided and still works 60 days later", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    const b2 = await buy(c, 4, 200_000n);
    await settle(c, 19_600_000, true);
    expect((await fetchMarket(c)).state).toEqual({ voided: {} });
    const before = bal(c, b.usdc);
    let r = send(c, b.kp, await refundIx(c, b));
    expect(failed(r), logs(r)).toBe(false);
    expect(bal(c, b.usdc) - before).toBe(1_200_000n);
    await warpTo(c.h.context, MONDAY + 60 * DAY);
    const before2 = bal(c, b2.usdc);
    r = send(c, b2.kp, await refundIx(c, b2));
    expect(failed(r), logs(r)).toBe(false);
    expect(bal(c, b2.usdc) - before2).toBe(800_000n);
    expect(bal(c, c.a.escrow)).toBe(0n);
    expect((await fetchMarket(c)).openPositions).toBe(0);
    expectError(send(c, b2.kp, await refundIx(c, b2)), "PositionClosed");
  });

  it("fails outside Voided", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    expectError(send(c, b.kp, await refundIx(c, b)), "WrongState");
  });

  it("pays only the owner's account", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000, true);
    const thief = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    expectError(send(c, b.kp, await refundIx(c, b, thief)), "InvalidMint");
  });
});

describe("sweep", () => {
  it("fails before 30 days, succeeds after, sends escrow to the dealer once", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    const caller = await stranger(c);
    const st = await settledAt(c);
    await warpTo(c.h.context, st + 30 * DAY);
    expectError(send(c, caller, await sweepIx(c, caller.publicKey)), "TooEarly");
    await warpTo(c.h.context, st + 30 * DAY + 1);
    const before = bal(c, c.dealerUsdc);
    const r = send(c, caller, await sweepIx(c, caller.publicKey));
    expect(failed(r), logs(r)).toBe(false);
    expect(bal(c, c.dealerUsdc) - before).toBe(2_500_000n);
    expect(bal(c, c.a.escrow)).toBe(0n);
    expect((await fetchMarket(c)).swept).toBe(true);
    expectError(send(c, caller, await sweepIx(c, caller.publicKey)), "AlreadySwept");
    // a paying claim after the sweep fails with a clear error
    expectError(send(c, b.kp, await claimIx(c, b)), "AlreadySwept");
  });

  it("runs from settlement: a finalise 10 days late pushes the deadline out", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await sandboxPrice(c, "monday", 19_600_000);
    await warpTo(c.h.context, MONDAY + 10 * DAY);
    const settledAt = MONDAY + 10 * DAY;
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    expect(failed(send(c, c.h.payer, await finaliseIx(c, c.h.payer.publicKey, sub)))).toBe(false);
    expect(Number((await fetchMarket(c)).settledAt)).toBe(settledAt);
    await warpTo(c.h.context, MONDAY + 31 * DAY);
    expectError(send(c, c.h.payer, await sweepIx(c, c.h.payer.publicKey)), "TooEarly");
    await warpTo(c.h.context, settledAt + 30 * DAY + 1);
    expect(failed(send(c, c.h.payer, await sweepIx(c, c.h.payer.publicKey)))).toBe(false);
  });

  it("fails in Voided, even long after", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000, true);
    await warpTo(c.h.context, MONDAY + 90 * DAY);
    expectError(send(c, c.h.payer, await sweepIx(c, c.h.payer.publicKey)), "WrongState");
    expect(bal(c, c.a.escrow)).toBe(1_200_000n);
    const r = send(c, b.kp, await refundIx(c, b));
    expect(failed(r), logs(r)).toBe(false);
  });
});

describe("close_market", () => {
  it("fails with open positions", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    expectError(send(c, c.h.payer, await closeIx(c, c.h.payer.publicKey)), "CannotClose");
  });

  it("fails before settlement even with no positions", async () => {
    const c = await setup();
    expectError(send(c, c.h.payer, await closeIx(c, c.h.payer.publicKey)), "CannotClose");
  });

  it("succeeds when open_positions is 0 and returns rent to the dealer", async () => {
    const c = await setup();
    const b = await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    expect(failed(send(c, b.kp, await claimIx(c, b)))).toBe(false);
    const caller = await stranger(c);
    const before = c.h.context.getBalance(c.h.payer.publicKey)!;
    const r = send(c, caller, await closeIx(c, caller.publicKey));
    expect(failed(r), logs(r)).toBe(false);
    expect(c.h.context.getAccount(c.a.market)).toBeNull();
    expect(c.h.context.getBalance(c.h.payer.publicKey)! > before).toBe(true);
  });

  it("succeeds when swept, even with open positions", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await settle(c, 19_600_000);
    const st = await settledAt(c);
    await warpTo(c.h.context, st + 30 * DAY + 1);
    expect(failed(send(c, c.h.payer, await sweepIx(c, c.h.payer.publicKey)))).toBe(false);
    const r = send(c, c.h.payer, await closeIx(c, c.h.payer.publicKey));
    expect(failed(r), logs(r)).toBe(false);
  });

  it("succeeds when voided with no sales", async () => {
    const c = await setup();
    await settle(c, 19_600_000, true);
    expect((await fetchMarket(c)).state).toEqual({ voided: {} });
    const r = send(c, c.h.payer, await closeIx(c, c.h.payer.publicKey));
    expect(failed(r), logs(r)).toBe(false);
  });

  it("fails when voided with unrefunded sales", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await settle(c, 19_600_000, true);
    expectError(send(c, c.h.payer, await closeIx(c, c.h.payer.publicKey)), "CannotClose");
  });

  it("refuses a rent destination that is not the dealer", async () => {
    const c = await setup();
    await settle(c, 19_600_000, true);
    const ix = await c.h.program.methods.closeMarket().accounts({
      caller: c.h.payer.publicKey, market: c.a.market, dealer: Keypair.generate().publicKey,
    }).instruction();
    expect(failed(send(c, c.h.payer, ix))).toBe(true);
  });
});

describe("idl", () => {
  it("idl has no transfer instruction", () => {
    const idl = JSON.parse(readFileSync(new URL("../idl/gap_cover.json", import.meta.url), "utf8"));
    expect(idl.instructions.map((i: any) => i.name)).toEqual([
      "create_market", "submit_report", "submit_sandbox_price", "finalise_friday", "finalise_monday",
      "buy", "claim", "refund", "sweep", "close_market",
    ]);
  });
});
