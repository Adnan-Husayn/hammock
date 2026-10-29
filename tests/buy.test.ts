import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import {
  Harness, startHarness, warpTo, createScaledMint, createUsdcMint, mintUsdc, tokenBalance, sendTx, failed, SendResult,
  fixturePayload, LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY,
} from "./harness";

const FRIDAY = 1_793_280_672;
const MONDAY = FRIDAY + 66 * 3600;
const UNIT = 1_000_000n;

const pda = (h: Harness, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
function i64le(v: number | bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; }
function u64le(v: number | bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function u32le(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
const logs = (r: SendResult) => (failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : r.logs().join("\n"));
function expectError(r: SendResult, name: string) {
  expect(failed(r), "expected the transaction to fail").toBe(true);
  expect(logs(r)).toContain(`Error Code: ${name}.`);
}

type Opts = { sandbox?: boolean; maxContracts?: number; skipFriday?: boolean };

async function setup(o: Opts = {}) {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, 1_000_000_000n);
  const quoteKey = Keypair.generate();
  const demo = Keypair.generate();
  h.context.airdrop(demo.publicKey, 1_000_000_000n);
  const market = pda(h, [Buffer.from("market"), h.payer.publicKey.toBuffer(), i64le(FRIDAY)]);
  const a = {
    market,
    vaultAuthority: pda(h, [Buffer.from("vault"), market.toBuffer()]),
    escrow: pda(h, [Buffer.from("escrow"), market.toBuffer()]),
    collateralReserve: pda(h, [Buffer.from("collateral"), market.toBuffer()]),
    bountyReserve: pda(h, [Buffer.from("bounty"), market.toBuffer()]),
  };
  const sandbox = o.sandbox ?? true;
  const params = {
    fridayTargetTs: new BN(FRIDAY), mondayTargetTs: new BN(MONDAY), buyingCloseTs: new BN(MONDAY - 3600),
    bandLowerBps: 100, bandUpperBps: 500, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10,
    maxContracts: o.maxContracts ?? 50, bountyPerLeg: new BN(100_000), dealerQuoteKey: quoteKey.publicKey,
    sandbox, demoAuthority: sandbox ? demo.publicKey : PublicKey.default, sandboxMode: { gap: {} },
  };
  await warpTo(h.context, FRIDAY - 7200);
  const ix = await h.program.methods.createMarket(params).accounts({
    dealer: h.payer.publicKey, market, vaultAuthority: a.vaultAuthority, usdcMint: usdc, nvdaxMint: nvdax,
    escrow: a.escrow, collateralReserve: a.collateralReserve, bountyReserve: a.bountyReserve,
    dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  const r = sendTx(h.context, h.payer, [ix]);
  expect(failed(r), logs(r)).toBe(false);
  const c = { h, usdc, nvdax, dealerUsdc, quoteKey, demo, a, now: FRIDAY - 7200 };
  if (sandbox && !o.skipFriday) await sandboxPrice(c, "friday");
  return c;
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function sandboxPrice(c: Ctx, leg: "friday" | "monday") {
  const ix = await c.h.program.methods.submitSandboxPrice({ [leg]: {} } as any, new BN(20_000_000))
    .accounts({ demoAuthority: c.demo.publicKey, market: c.a.market }).instruction();
  const r = sendTx(c.h.context, c.demo, [ix]);
  expect(failed(r), logs(r)).toBe(false);
}

async function newBuyer(c: Ctx, usdc = 100_000_000n) {
  const kp = Keypair.generate();
  c.h.context.airdrop(kp.publicKey, 1_000_000_000n);
  const acct = await mintUsdc(c.h.context, c.usdc, kp.publicKey, usdc);
  return { kp, usdc: acct };
}
type Buyer = Awaited<ReturnType<typeof newBuyer>>;

type Q = { market?: PublicKey; buyer?: PublicKey; contracts?: number; premium?: bigint; expiry?: number; nonce?: bigint };
function quoteMsg(c: Ctx, b: Buyer, q: Q = {}) {
  return Buffer.concat([
    Buffer.from("MGCQ"), (q.market ?? c.a.market).toBuffer(), (q.buyer ?? b.kp.publicKey).toBuffer(),
    u32le(q.contracts ?? 10), u64le(q.premium ?? 120_000n), i64le(q.expiry ?? c.now + 60), u64le(q.nonce ?? 1n),
  ]);
}
const positionOf = (c: Ctx, buyer: PublicKey) => pda(c.h, [Buffer.from("position"), c.a.market.toBuffer(), buyer.toBuffer()]);

async function buyIx(c: Ctx, b: Buyer, buyerUsdc = b.usdc) {
  return c.h.program.methods.buy().accounts({
    buyer: b.kp.publicKey, market: c.a.market, position: positionOf(c, b.kp.publicKey), vaultAuthority: c.a.vaultAuthority,
    usdcMint: c.usdc, escrow: c.a.escrow, collateralReserve: c.a.collateralReserve, buyerUsdc,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).instruction();
}
function edIx(signer: Keypair, msg: Buffer) {
  return Ed25519Program.createInstructionWithPrivateKey({ privateKey: signer.secretKey, message: msg });
}
async function buy(c: Ctx, b: Buyer, q: Q = {}, signer = c.quoteKey, msg?: Buffer) {
  return sendTx(c.h.context, b.kp, [edIx(signer, msg ?? quoteMsg(c, b, q)), await buyIx(c, b)]);
}
async function fetchMarket(c: Ctx) {
  return c.h.program.coder.accounts.decode("market", Buffer.from(c.h.context.getAccount(c.a.market)!.data)) as any;
}
async function fetchPosition(c: Ctx, buyer: PublicKey) {
  return c.h.program.coder.accounts.decode("position", Buffer.from(c.h.context.getAccount(positionOf(c, buyer))!.data)) as any;
}

describe("buy", () => {
  it("moves the premium from the buyer and the rest from the reserve; escrow equals contracts_sold * 1 USDC", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    const r = await buy(c, b, { contracts: 10, premium: 120_000n });
    expect(failed(r), logs(r)).toBe(false);
    expect(tokenBalance(c.h.context, b.usdc)).toBe(100_000_000n - 1_200_000n);
    expect(tokenBalance(c.h.context, c.a.escrow)).toBe(10n * UNIT);
    expect(tokenBalance(c.h.context, c.a.collateralReserve)).toBe(50n * UNIT - 8_800_000n);
    let m = await fetchMarket(c);
    expect(m.contractsSold).toBe(10);
    expect(m.totalPremiums.toString()).toBe("1200000");
    expect(m.openPositions).toBe(1);
    const p = await fetchPosition(c, b.kp.publicKey);
    expect(p.contracts).toBe(10);
    expect(p.premiumPaid.toString()).toBe("1200000");
    expect(p.lastNonce.toString()).toBe("1");
    expect(p.closed).toBe(false);

    const r2 = await buy(c, b, { contracts: 5, premium: 300_000n, nonce: 2n });
    expect(failed(r2), logs(r2)).toBe(false);
    const b2 = await newBuyer(c);
    const r3 = await buy(c, b2, { contracts: 3, premium: 999_999n });
    expect(failed(r3), logs(r3)).toBe(false);
    m = await fetchMarket(c);
    expect(m.contractsSold).toBe(18);
    expect(m.openPositions).toBe(2);
    expect(tokenBalance(c.h.context, c.a.escrow)).toBe(18n * UNIT);
    expect(m.totalPremiums.toString()).toBe(String(1_200_000 + 1_500_000 + 2_999_997));
    expect((await fetchPosition(c, b.kp.publicKey)).contracts).toBe(15);
  });

  it("real market: WrongState before FridayFinal, sells after finalise_friday, BuyingClosed at buying_close_ts", async () => {
    const c = await setup({ sandbox: false });
    const b = await newBuyer(c);
    expectError(await buy(c, b), "WrongState");
    await warpTo(c.h.context, FRIDAY);
    const submitter = Keypair.generate();
    c.h.context.airdrop(submitter.publicKey, 1_000_000_000n);
    const payload = fixturePayload("regular-2026-10-29");
    const rep = await c.h.program.methods.submitReport({ friday: {} } as any, payload).accounts({
      submitter: submitter.publicKey, market: c.a.market, lazerProgram: LAZER_PROGRAM_ID, lazerStorage: LAZER_STORAGE,
      lazerTreasury: LAZER_TREASURY, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    }).instruction();
    let r = sendTx(c.h.context, submitter, [createEd25519Instruction(payload, 1, 13), rep]);
    expect(failed(r), logs(r)).toBe(false);
    const subUsdc = await mintUsdc(c.h.context, c.usdc, submitter.publicKey, 0n);
    c.now = FRIDAY + 7 * 60 + 1;
    await warpTo(c.h.context, c.now);
    const fin = await c.h.program.methods.finaliseFriday().accounts({
      caller: c.h.payer.publicKey, market: c.a.market, vaultAuthority: c.a.vaultAuthority, usdcMint: c.usdc, nvdaxMint: c.nvdax,
      escrow: c.a.escrow, collateralReserve: c.a.collateralReserve, bountyReserve: c.a.bountyReserve,
      submitterUsdc: subUsdc, dealerUsdc: c.dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    r = sendTx(c.h.context, c.h.payer, [fin]);
    expect(failed(r), logs(r)).toBe(false);
    expect((await fetchMarket(c)).state).toEqual({ fridayFinal: {} });

    // well past the sandbox cap: real markets are not limited by it
    c.now = FRIDAY + 3600;
    await warpTo(c.h.context, c.now);
    r = await buy(c, b, { contracts: 4, premium: 250_000n });
    expect(failed(r), logs(r)).toBe(false);
    expect(tokenBalance(c.h.context, c.a.escrow)).toBe(4n * UNIT);

    c.now = MONDAY - 3601;
    await warpTo(c.h.context, c.now);
    expect(failed(await buy(c, b, { contracts: 1, nonce: 2n }))).toBe(false);
    c.now = MONDAY - 3600;
    await warpTo(c.h.context, c.now);
    expectError(await buy(c, b, { contracts: 1, nonce: 3n }), "BuyingClosed");
    expect(tokenBalance(c.h.context, c.a.escrow)).toBe(5n * UNIT);
  });

  it("fails before FridayFinal on a sandbox market too", async () => {
    const c = await setup({ skipFriday: true });
    const b = await newBuyer(c);
    expectError(await buy(c, b), "WrongState");
  });

  it("rejects a 95- or 97-byte message with BadQuote", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    const m = quoteMsg(c, b);
    expectError(await buy(c, b, {}, c.quoteKey, m.subarray(0, 95)), "BadQuote");
    expectError(await buy(c, b, {}, c.quoteKey, Buffer.concat([m, Buffer.from([0])])), "BadQuote");
    const bad = Buffer.from(m); bad[0] = 0x58;
    expectError(await buy(c, b, {}, c.quoteKey, bad), "BadQuote");
  });

  it("rejects a quote for another market", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { market: Keypair.generate().publicKey }), "BadQuote");
  });

  it("rejects a quote not signed by the dealer's quote key", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, {}, Keypair.generate()), "WrongSigner");
    expectError(await buy(c, b, {}, b.kp), "WrongSigner");
  });

  it("rejects a forged signature in the precompile", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    const ed = edIx(c.quoteKey, quoteMsg(c, b));
    ed.data[112 + 40] ^= 1; // change contracts after signing
    expect(failed(sendTx(c.h.context, b.kp, [ed, await buyIx(c, b)]))).toBe(true);
  });

  it("rejects a quote for another buyer", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { buyer: Keypair.generate().publicKey }), "WrongBuyer");
  });

  it("rejects an expired quote", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { expiry: c.now - 1 }), "QuoteExpired");
  });

  it("rejects an expiry beyond the 90 s lifetime", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { expiry: c.now + 91 }), "BadQuote");
  });

  it("rejects a skipped nonce and a nonce of 0", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { nonce: 2n }), "BadNonce");
    expectError(await buy(c, b, { nonce: 0n }), "QuoteUsed");
  });

  it("Review Focus 2: two quotes with the same nonce charge once; the second fails QuoteUsed", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expect(failed(await buy(c, b, { contracts: 2, premium: 100_000n }))).toBe(false);
    const after = tokenBalance(c.h.context, b.usdc);
    expectError(await buy(c, b, { contracts: 3, premium: 200_000n }), "QuoteUsed");
    expectError(await buy(c, b, { contracts: 2, premium: 100_000n, expiry: c.now + 59 }), "QuoteUsed");
    expect(tokenBalance(c.h.context, b.usdc)).toBe(after);
    expect(tokenBalance(c.h.context, c.a.escrow)).toBe(2n * UNIT);
  });

  it("rejects premium 0 and premium 1_000_000", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    expectError(await buy(c, b, { premium: 0n }), "BadPremium");
    expectError(await buy(c, b, { premium: 1_000_000n }), "BadPremium");
    expectError(await buy(c, b, { contracts: 0 }), "BadQuote");
  });

  it("rejects over capacity", async () => {
    const c = await setup({ maxContracts: 5 });
    const b = await newBuyer(c);
    expectError(await buy(c, b, { contracts: 6 }), "OverCapacity");
    expect(failed(await buy(c, b, { contracts: 5 }))).toBe(false);
    expectError(await buy(c, b, { contracts: 1, nonce: 2n }), "OverCapacity");
  });

  it("rejects after buying_closed (Monday bell)", async () => {
    const c = await setup();
    await sandboxPrice(c, "monday");
    const b = await newBuyer(c);
    expectError(await buy(c, b), "BuyingClosed");
  });

  it("rejects after the sandbox 10-minute buying cap", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    await warpTo(c.h.context, c.now + 601);
    expectError(await buy(c, b, { expiry: c.now + 650 }), "BuyingClosed");
  });

  it("rejects when the Ed25519 instruction is not at index 0", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    // buy at index 1 but index 0 is not Ed25519
    expectError(sendTx(c.h.context, b.kp, [SystemProgram.transfer({ fromPubkey: b.kp.publicKey, toPubkey: b.kp.publicKey, lamports: 0 }), await buyIx(c, b)]), "NotEd25519");
    // Ed25519 at index 1, buy at index 2
    expectError(sendTx(c.h.context, b.kp, [SystemProgram.transfer({ fromPubkey: b.kp.publicKey, toPubkey: b.kp.publicKey, lamports: 0 }), edIx(c.quoteKey, quoteMsg(c, b)), await buyIx(c, b)]), "WrongInstructionIndex");
  });

  it("rejects a buyer USDC account the buyer does not own", async () => {
    const c = await setup();
    const b = await newBuyer(c);
    const other = await newBuyer(c);
    const r = sendTx(c.h.context, b.kp, [edIx(c.quoteKey, quoteMsg(c, b)), await buyIx(c, b, other.usdc)]);
    expectError(r, "InvalidMint");
  });
});
