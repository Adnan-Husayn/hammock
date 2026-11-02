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

describe("finalise_monday", () => {
  it("2% fall: payout 250_000, escrow keeps contracts_sold * 250_000, dealer gets the rest, bounty to the submitter", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await buy(c, 4, 200_000n);
    await sandboxPrice(c, "monday", 19_600_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    const dealerBefore = bal(c, c.dealerUsdc);
    const reserve = bal(c, c.a.collateralReserve);
    const caller = await stranger(c);
    const r = sendTx(c.h.context, caller, [await finaliseIx(c, caller.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    const m = await fetchMarket(c);
    expect(m.state).toEqual({ mondayFinal: {} });
    expect(m.payoutPerContract.toString()).toBe("250000");
    expect(bal(c, c.a.escrow)).toBe(14n * 250_000n);
    expect(bal(c, sub)).toBe(100_000n);
    expect(bal(c, c.a.collateralReserve)).toBe(0n);
    expect(bal(c, c.a.bountyReserve)).toBe(0n);
    // escrow remainder + unused reserve + the sandbox Friday bounty that was never paid
    expect(bal(c, c.dealerUsdc) - dealerBefore).toBe(14n * UNIT - 14n * 250_000n + reserve + 100_000n);
  });

  it("a rise sets payout 0 without failing; escrow keeps nothing", async () => {
    const c = await setup();
    await buy(c, 5, 300_000n);
    await sandboxPrice(c, "monday", 21_000_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    const m = await fetchMarket(c);
    expect(m.state).toEqual({ mondayFinal: {} });
    expect(m.payoutPerContract.toString()).toBe("0");
    expect(bal(c, c.a.escrow)).toBe(0n);
    expect(bal(c, sub)).toBe(100_000n);
  });

  it("a fall beyond the band pays the full unit", async () => {
    const c = await setup();
    await buy(c, 3, 500_000n);
    await sandboxPrice(c, "monday", 18_000_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    expect((await fetchMarket(c)).payoutPerContract.toString()).toBe("1000000");
    expect(bal(c, c.a.escrow)).toBe(3n * UNIT);
  });

  it("multiplier differs at Monday: Voided, escrow keeps total_premiums, dealer gets the rest in the same instruction", async () => {
    const c = await setup();
    await buy(c, 10, 120_000n);
    await buy(c, 4, 200_000n);
    await scheduleMultiplier(c.h.context, c.nvdax, 1.0025, c.now - 10);
    await sandboxPrice(c, "monday", 19_600_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    const dealerBefore = bal(c, c.dealerUsdc);
    const reserve = bal(c, c.a.collateralReserve);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    const m = await fetchMarket(c);
    expect(m.state).toEqual({ voided: {} });
    const premiums = 1_200_000n + 800_000n;
    expect(m.totalPremiums.toString()).toBe(premiums.toString());
    expect(bal(c, c.a.escrow)).toBe(premiums);
    expect(bal(c, sub)).toBe(0n);
    expect(bal(c, c.a.collateralReserve)).toBe(0n);
    expect(bal(c, c.a.bountyReserve)).toBe(0n);
    expect(bal(c, c.dealerUsdc) - dealerBefore).toBe(14n * UNIT - premiums + reserve + 200_000n);
  });

  it("sandbox: WindowOpen before the Monday price is set", async () => {
    const c = await setup();
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]), "WindowOpen");
  });

  it("fails WrongState a second time", async () => {
    const c = await setup();
    await sandboxPrice(c, "monday", 19_600_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    expect(failed(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]))).toBe(false);
    c.h.context.expireBlockhash();
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub)]), "WrongState");
  });

  it("rejects a dealer account the dealer does not own", async () => {
    const c = await setup();
    await buy(c, 2, 100_000n);
    await sandboxPrice(c, "monday", 19_600_000);
    const sub = await mintUsdc(c.h.context, c.usdc, c.demo.publicKey, 0n);
    const thief = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, sub, thief)]), "InvalidMint");
  });

  it("rejects a bounty account that is not the Monday submitter's", async () => {
    const c = await setup();
    await sandboxPrice(c, "monday", 19_600_000);
    const wrong = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, wrong)]), "InvalidMint");
  });

  it("real market: WindowOpen until Monday + 7 min, then no candidate voids with refunds kept", async () => {
    const c = await setup(false);
    await warpTo(c.h.context, FRIDAY);
    const submitter = await stranger(c);
    const payload = fixturePayload("regular-2026-10-29");
    const rep = await c.h.program.methods.submitReport({ friday: {} } as any, payload).accounts({
      submitter: submitter.publicKey, market: c.a.market, lazerProgram: LAZER_PROGRAM_ID, lazerStorage: LAZER_STORAGE,
      lazerTreasury: LAZER_TREASURY, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    }).instruction();
    let r = sendTx(c.h.context, submitter, [createEd25519Instruction(payload, 1, 13), rep]);
    expect(failed(r), logs(r)).toBe(false);
    const fridaySub = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    await warpTo(c.h.context, FRIDAY + 7 * 60 + 1);
    const ff = await c.h.program.methods.finaliseFriday().accounts({
      caller: c.h.payer.publicKey, market: c.a.market, vaultAuthority: c.a.vaultAuthority, usdcMint: c.usdc, stockMint: c.nvdax,
      escrow: c.a.escrow, collateralReserve: c.a.collateralReserve, bountyReserve: c.a.bountyReserve,
      submitterUsdc: fridaySub, dealerUsdc: c.dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    r = sendTx(c.h.context, c.h.payer, [ff]);
    expect(failed(r), logs(r)).toBe(false);
    c.now = FRIDAY + 7 * 60 + 1;
    await buy(c, 6, 250_000n);

    await warpTo(c.h.context, MONDAY + 7 * 60);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, fridaySub)]), "WindowOpen");
    await warpTo(c.h.context, MONDAY + 7 * 60 + 1);
    const dealerBefore = bal(c, c.dealerUsdc);
    const reserve = bal(c, c.a.collateralReserve);
    r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, c.h.payer.publicKey, fridaySub)]);
    expect(failed(r), logs(r)).toBe(false);
    expect((await fetchMarket(c)).state).toEqual({ voided: {} });
    expect(bal(c, c.a.escrow)).toBe(1_500_000n);
    expect(bal(c, fridaySub)).toBe(100_000n);
    expect(bal(c, c.dealerUsdc) - dealerBefore).toBe(6n * UNIT - 1_500_000n + reserve + 100_000n);
  });
});
