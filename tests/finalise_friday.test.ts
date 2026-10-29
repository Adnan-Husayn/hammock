import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import {
  Harness, startHarness, warpTo, fixturePayload, createScaledMint, scheduleMultiplier, createUsdcMint, mintUsdc,
  tokenBalance, sendTx, failed, SendResult, LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY,
} from "./harness";

const FRIDAY = 1_793_280_672; // the regular fixture is a valid report for this target
const MONDAY = FRIDAY + 66 * 3600;
const REGULAR = "regular-2026-10-29";
const ENVELOPE_OFFSET = 13;

async function setup() {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, 1_000_000_000n);
  return { h, usdc, nvdax, dealerUsdc };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const pda = (h: Harness, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
function i64le(v: number) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; }
const logs = (r: SendResult) => (failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : r.logs().join("\n"));
function expectError(r: SendResult, name: string) {
  expect(failed(r), "expected the transaction to fail").toBe(true);
  expect(logs(r)).toContain(`Error Code: ${name}.`);
}

async function createMarketAt(c: Ctx) {
  const market = pda(c.h, [Buffer.from("market"), c.h.payer.publicKey.toBuffer(), i64le(FRIDAY)]);
  const a = {
    market,
    vaultAuthority: pda(c.h, [Buffer.from("vault"), market.toBuffer()]),
    escrow: pda(c.h, [Buffer.from("escrow"), market.toBuffer()]),
    collateralReserve: pda(c.h, [Buffer.from("collateral"), market.toBuffer()]),
    bountyReserve: pda(c.h, [Buffer.from("bounty"), market.toBuffer()]),
  };
  const params = {
    fridayTargetTs: new BN(FRIDAY), mondayTargetTs: new BN(MONDAY), buyingCloseTs: new BN(MONDAY - 3600),
    bandLowerBps: 100, bandUpperBps: 500, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10,
    maxContracts: 50, bountyPerLeg: new BN(100_000), dealerQuoteKey: Keypair.generate().publicKey,
    sandbox: false, demoAuthority: PublicKey.default, sandboxMode: { gap: {} },
  };
  await warpTo(c.h.context, FRIDAY - 7200);
  const ix = await c.h.program.methods.createMarket(params).accounts({
    dealer: c.h.payer.publicKey, market, vaultAuthority: a.vaultAuthority, usdcMint: c.usdc, nvdaxMint: c.nvdax,
    escrow: a.escrow, collateralReserve: a.collateralReserve, bountyReserve: a.bountyReserve,
    dealerUsdc: c.dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  const r = sendTx(c.h.context, c.h.payer, [ix]);
  expect(failed(r), logs(r)).toBe(false);
  return a;
}

async function report(c: Ctx, market: PublicKey, who: Keypair) {
  c.h.context.airdrop(who.publicKey, 1_000_000_000n);
  const msg = fixturePayload(REGULAR);
  const ix = await c.h.program.methods.submitReport({ friday: {} } as any, msg).accounts({
    submitter: who.publicKey, market, lazerProgram: LAZER_PROGRAM_ID, lazerStorage: LAZER_STORAGE,
    lazerTreasury: LAZER_TREASURY, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).instruction();
  const r = sendTx(c.h.context, who, [createEd25519Instruction(msg, 1, ENVELOPE_OFFSET), ix]);
  expect(failed(r), logs(r)).toBe(false);
}

async function finaliseIx(c: Ctx, a: Awaited<ReturnType<typeof createMarketAt>>, caller: PublicKey, submitterUsdc: PublicKey, dealerUsdc = c.dealerUsdc) {
  return c.h.program.methods.finaliseFriday().accounts({
    caller, market: a.market, vaultAuthority: a.vaultAuthority, usdcMint: c.usdc, nvdaxMint: c.nvdax,
    escrow: a.escrow, collateralReserve: a.collateralReserve, bountyReserve: a.bountyReserve,
    submitterUsdc, dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}

async function fetchMarket(c: Ctx, market: PublicKey) {
  return c.h.program.coder.accounts.decode("market", Buffer.from(c.h.context.getAccount(market)!.data)) as any;
}

const AFTER = FRIDAY + 7 * 60 + 1;

describe("finalise_friday", () => {
  it("with a candidate: FridayFinal and 100_000 to the submitter's account, by a stranger", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const submitter = Keypair.generate();
    await warpTo(c.h.context, FRIDAY);
    await report(c, a.market, submitter);
    const sub = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    await warpTo(c.h.context, AFTER);
    const stranger = Keypair.generate();
    c.h.context.airdrop(stranger.publicKey, 1_000_000_000n);
    const r = sendTx(c.h.context, stranger, [await finaliseIx(c, a, stranger.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    expect(tokenBalance(c.h.context, sub)).toBe(100_000n);
    expect(tokenBalance(c.h.context, a.bountyReserve)).toBe(100_000n);
    expect(tokenBalance(c.h.context, a.collateralReserve)).toBe(50_000_000n);
    expect((await fetchMarket(c, a.market)).state).toEqual({ fridayFinal: {} });
  });

  it("without a candidate: Voided and every reserve returned to the dealer", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const before = tokenBalance(c.h.context, c.dealerUsdc);
    await warpTo(c.h.context, AFTER);
    const anyone = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, anyone)]);
    expect(failed(r), logs(r)).toBe(false);
    expect(tokenBalance(c.h.context, c.dealerUsdc) - before).toBe(50_200_000n);
    expect(tokenBalance(c.h.context, a.collateralReserve)).toBe(0n);
    expect(tokenBalance(c.h.context, a.bountyReserve)).toBe(0n);
    expect((await fetchMarket(c, a.market)).state).toEqual({ voided: {} });
  });

  it("fails WindowOpen before T + 7 min", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const anyone = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    await warpTo(c.h.context, FRIDAY + 7 * 60);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, anyone)]), "WindowOpen");
  });

  it("fails WrongState a second time", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const anyone = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    await warpTo(c.h.context, AFTER);
    const ix = await finaliseIx(c, a, c.h.payer.publicKey, anyone);
    expect(failed(sendTx(c.h.context, c.h.payer, [ix]))).toBe(false);
    c.h.context.expireBlockhash();
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, anyone)]), "WrongState");
  });

  it("rejects a bounty account that is not the submitter's", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const submitter = Keypair.generate();
    await warpTo(c.h.context, FRIDAY);
    await report(c, a.market, submitter);
    const wrong = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    await warpTo(c.h.context, AFTER);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, wrong)]), "InvalidMint");
  });

  it("rejects a refund account that is not the dealer's on a void", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const thief = await mintUsdc(c.h.context, c.usdc, Keypair.generate().publicKey, 0n);
    await warpTo(c.h.context, AFTER);
    expectError(sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, thief, thief)]), "InvalidMint");
  });

  it("voids when a multiplier change is scheduled before the Monday target, even with a candidate", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const submitter = Keypair.generate();
    await warpTo(c.h.context, FRIDAY);
    await report(c, a.market, submitter);
    const sub = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    await scheduleMultiplier(c.h.context, c.nvdax, 1.0025, MONDAY - 3600);
    await warpTo(c.h.context, AFTER);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    expect((await fetchMarket(c, a.market)).state).toEqual({ voided: {} });
    expect(tokenBalance(c.h.context, sub)).toBe(0n);
    expect(tokenBalance(c.h.context, a.collateralReserve)).toBe(0n);
  });

  it("does not void for a change scheduled after the Monday target", async () => {
    const c = await setup();
    const a = await createMarketAt(c);
    const submitter = Keypair.generate();
    await warpTo(c.h.context, FRIDAY);
    await report(c, a.market, submitter);
    const sub = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    await scheduleMultiplier(c.h.context, c.nvdax, 1.0025, MONDAY + 3600);
    await warpTo(c.h.context, AFTER);
    const r = sendTx(c.h.context, c.h.payer, [await finaliseIx(c, a, c.h.payer.publicKey, sub)]);
    expect(failed(r), logs(r)).toBe(false);
    expect((await fetchMarket(c, a.market)).state).toEqual({ fridayFinal: {} });
  });
});
