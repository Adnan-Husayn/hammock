// The service's finalise transaction, run against the real program with each state of the submitter's USDC ATA.
import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import {
  AuthorityType, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSetAuthorityInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import {
  createScaledMint, createUsdcMint, failed, fixturePayload, mintUsdc, sendTx, startHarness, tokenBalance, warpTo,
  LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY,
} from "./harness";
import { finaliseInstructions } from "../service/src/chain.ts";
import { decodeMarket } from "../service/src/quote.ts";

const FRIDAY = 1_793_280_672;
const MONDAY = FRIDAY + 66 * 3600;
const AFTER = FRIDAY + 7 * 60 + 1;
const logs = (r: any) => (failed(r) ? `${r.toString()}\n${r.meta().logs().join("\n")}` : "");
function i64le(v: number) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; }

async function setup(withReport = true) {
  const h = await startHarness();
  const usdc = await createUsdcMint(h.context);
  const nvdax = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
  const dealerUsdc = await mintUsdc(h.context, usdc, h.payer.publicKey, 1_000_000_000n);
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, h.program.programId)[0];
  const market = pda([Buffer.from("market"), h.payer.publicKey.toBuffer(), i64le(FRIDAY)]);
  await warpTo(h.context, FRIDAY - 7200);
  const ix = await h.program.methods.createMarket({
    fridayTargetTs: new BN(FRIDAY), mondayTargetTs: new BN(MONDAY), buyingCloseTs: new BN(MONDAY - 3600),
    bandLowerBps: 100, bandUpperBps: 500, fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10,
    maxContracts: 50, bountyPerLeg: new BN(100_000), dealerQuoteKey: Keypair.generate().publicKey,
    sandbox: false, demoAuthority: PublicKey.default, sandboxMode: { gap: {} },
  } as any).accounts({
    dealer: h.payer.publicKey, market, vaultAuthority: pda([Buffer.from("vault"), market.toBuffer()]), usdcMint: usdc, nvdaxMint: nvdax,
    escrow: pda([Buffer.from("escrow"), market.toBuffer()]), collateralReserve: pda([Buffer.from("collateral"), market.toBuffer()]),
    bountyReserve: pda([Buffer.from("bounty"), market.toBuffer()]), dealerUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  } as any).instruction();
  const created = sendTx(h.context, h.payer, [ix]);
  expect(failed(created), logs(created)).toBe(false);

  const submitter = Keypair.generate();
  h.context.airdrop(submitter.publicKey, 1_000_000_000n);
  if (withReport) {
    await warpTo(h.context, FRIDAY);
    const msg = fixturePayload("regular-2026-10-29");
    const rep = await h.program.methods.submitReport({ friday: {} } as any, msg).accounts({
      submitter: submitter.publicKey, market, lazerProgram: LAZER_PROGRAM_ID, lazerStorage: LAZER_STORAGE,
      lazerTreasury: LAZER_TREASURY, systemProgram: SystemProgram.programId, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any).instruction();
    const r = sendTx(h.context, submitter, [createEd25519Instruction(msg, 1, 13), rep]);
    expect(failed(r), logs(r)).toBe(false);
  }
  const ata = getAssociatedTokenAddressSync(usdc, submitter.publicKey);
  const makeAta = () => {
    const r = sendTx(h.context, h.payer, [createAssociatedTokenAccountIdempotentInstruction(h.payer.publicKey, ata, submitter.publicKey, usdc)]);
    expect(failed(r), logs(r)).toBe(false);
  };
  const conn = {
    getAccountInfo: async (k: PublicKey) => {
      const a = h.context.getAccount(k);
      return a ? { ...a, data: Buffer.from(a.data) } : null;
    },
    getMinimumBalanceForRentExemption: async (n: number) => Number(h.context.minimumBalanceForRentExemption(BigInt(n))),
  } as any;
  const finalise = async () => {
    await warpTo(h.context, AFTER);
    const mk = decodeMarket(Buffer.from(h.context.getAccount(market)!.data));
    const plan = await finaliseInstructions(conn, h.program.programId, h.payer.publicKey, market, mk, "friday");
    const tx = new Transaction().add(...plan.instructions);
    tx.recentBlockhash = h.context.latestBlockhash();
    tx.feePayer = h.payer.publicKey;
    tx.sign(h.payer, ...plan.signers);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    const r = sendTx(h.context, h.payer, plan.instructions, plan.signers);
    expect(failed(r), logs(r)).toBe(false);
    const state = (h.program.coder.accounts.decode("market", Buffer.from(h.context.getAccount(market)!.data)) as any).state;
    return { plan, state, payee: plan.instructions.at(-1)!.keys[8].pubkey as PublicKey };
  };
  return { h, usdc, submitter, ata, makeAta, finalise, market };
}

const expectPaid = (c: Awaited<ReturnType<typeof setup>>, payee: PublicKey) => {
  expect(tokenBalance(c.h.context, payee)).toBe(100_000n);
  const d = Buffer.from(c.h.context.getAccount(payee)!.data);
  expect(new PublicKey(d.subarray(32, 64)).equals(c.submitter.publicKey)).toBe(true);
};

describe("finaliseInstructions on the program", () => {
  it("ATA present: pays it with no account created for the submitter", async () => {
    const c = await setup();
    c.makeAta();
    const { plan, state, payee } = await c.finalise();
    expect(state).toEqual({ fridayFinal: {} });
    expect(payee.equals(c.ata)).toBe(true);
    expect(plan.signers).toHaveLength(0);
    expect(plan.instructions).toHaveLength(2); // the harness dealer funded from a non-ATA, so its own ATA is created
    expectPaid(c, payee);
  });

  it("ATA missing: creates it and pays it", async () => {
    const c = await setup();
    const { state, payee } = await c.finalise();
    expect(state).toEqual({ fridayFinal: {} });
    expect(payee.equals(c.ata)).toBe(true);
    expectPaid(c, payee);
  });

  it("ATA closed: creates it again and pays it", async () => {
    const c = await setup();
    c.makeAta();
    const r = sendTx(c.h.context, c.submitter, [createCloseAccountInstruction(c.ata, c.submitter.publicKey, c.submitter.publicKey)]);
    expect(failed(r), logs(r)).toBe(false);
    const { state, payee } = await c.finalise();
    expect(state).toEqual({ fridayFinal: {} });
    expect(payee.equals(c.ata)).toBe(true);
    expectPaid(c, payee);
  });

  it("ATA reassigned: pays a fresh account the submitter owns, and settlement goes through", async () => {
    const c = await setup();
    c.makeAta();
    const r = sendTx(c.h.context, c.submitter, [createSetAuthorityInstruction(c.ata, c.submitter.publicKey, AuthorityType.AccountOwner, Keypair.generate().publicKey)]);
    expect(failed(r), logs(r)).toBe(false);
    const { plan, state, payee } = await c.finalise();
    expect(state).toEqual({ fridayFinal: {} });
    expect(payee.equals(c.ata)).toBe(false);
    expect(plan.signers.map((s) => s.publicKey.toBase58())).toEqual([payee.toBase58()]);
    expectPaid(c, payee);
  });

  it("no candidate: voids, with reserves back to the dealer's account", async () => {
    const c = await setup(false);
    const { state, plan } = await c.finalise();
    expect(state).toEqual({ voided: {} });
    const dealerAta = getAssociatedTokenAddressSync(c.usdc, c.h.payer.publicKey);
    expect(plan.instructions.at(-1)!.keys[9].pubkey.equals(dealerAta)).toBe(true);
    expect(tokenBalance(c.h.context, dealerAta)).toBe(50_200_000n);
  });
});
