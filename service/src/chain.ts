import { ACCOUNT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import { LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY } from "./config.ts";
import type { Leg } from "./archive.ts";
import type { Chain, MarketView } from "./keeper.ts";
import type { SignedUpdate } from "./pyth.ts";
import { readMarket, type MarketInfo } from "./quote.ts";

// submit_report data: 8 discriminator + 1 leg + 4 vec length, then the envelope.
export const ENVELOPE_OFFSET = 13;
const SUBMIT_REPORT_DISC = Buffer.from([27, 178, 64, 9, 20, 46, 250, 14]);

export function submitReportInstructions(
  programId: PublicKey,
  submitter: PublicKey,
  market: PublicKey,
  leg: Leg,
  message: Buffer,
): TransactionInstruction[] {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(message.length);
  const data = Buffer.concat([SUBMIT_REPORT_DISC, Buffer.from([leg === "friday" ? 0 : 1]), len, message]);
  const ix = new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(LAZER_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(LAZER_STORAGE), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(LAZER_TREASURY), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
  });
  // Ed25519 at index 0, submit_report at index 1 (the program rejects any other layout).
  return [createEd25519Instruction(message, 1, ENVELOPE_OFFSET), ix];
}

// Report-specific failures: the same bytes would fail again. Everything else (WrongState, WindowNotStarted,
// balance, compute, RPC) is retried. A "not strictly better" report is a successful no-op, not an error.
const REPORT_ERRORS = ["BadPayload", "WrongFeed", "WrongSession", "CarriedForward", "OutsideWindow", "ZeroPrice", "WrongExponent", "WideConfidence", "TooFewPublishers"];

export function isReportRejection(logs: readonly string[]): boolean {
  return logs.some(
    (l) =>
      REPORT_ERRORS.some((n) => l.includes(`Error Code: ${n}.`)) ||
      l.startsWith(`Program ${LAZER_PROGRAM_ID} failed`), // Lazer signature / format verification failed
  );
}

/** Send a submit_report transaction. Resolves true when confirmed, false when the report itself was rejected. */
export async function sendSubmitReport(
  conn: Connection,
  programId: PublicKey,
  payer: Keypair,
  market: PublicKey,
  leg: Leg,
  message: Buffer,
): Promise<boolean> {
  const tx = new Transaction().add(...submitReportInstructions(programId, payer.publicKey, market, leg, message));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    // It passed preflight with these bytes, so a failure on landing is about the moment, not the report.
    if (res.value.err) throw new Error(`submit_report failed on landing: ${JSON.stringify(res.value.err)}`);
    return true;
  } catch (e: any) {
    // Only a report-specific rejection returns false; any other failure throws so the keeper retries.
    const logs: string[] | undefined = Array.isArray(e?.logs) ? e.logs : Array.isArray(e?.transactionLogs) ? e.transactionLogs : undefined;
    if (logs && isReportRejection(logs)) return false;
    throw e;
  }
}

const FINALISE_DISC: Record<Leg, Buffer> = {
  friday: Buffer.from([74, 5, 224, 57, 250, 188, 201, 95]),
  monday: Buffer.from([190, 173, 33, 114, 145, 251, 234, 192]),
};

const usdcAta = (mk: MarketInfo, owner: PublicKey) => getAssociatedTokenAddressSync(mk.usdcMint, owner, true, mk.tokenProgram);

/** The finalise instruction for one leg; account order is the Finalise struct in finalise.rs. */
export function finaliseInstruction(
  programId: PublicKey,
  caller: PublicKey,
  market: PublicKey,
  mk: MarketInfo,
  leg: Leg,
  submitterUsdc: PublicKey,
  dealerUsdc: PublicKey,
): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId,
    data: FINALISE_DISC[leg],
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      rw(market),
      ro(vault),
      ro(mk.usdcMint),
      ro(mk.nvdaxMint),
      rw(mk.escrow),
      rw(mk.collateralReserve),
      rw(mk.bountyReserve),
      rw(submitterUsdc),
      rw(dealerUsdc),
      ro(mk.tokenProgram),
    ],
  });
}

/**
 * Picks the USDC account a finalise pays `owner` through, adding what the transaction must do first. The ATA is used
 * as it stands when it is right; a missing or closed one is created. An ATA reassigned to someone else, or otherwise
 * unusable, cannot be repaired, so a fresh account is made in the same transaction: nobody can stall settlement by
 * tampering with their own ATA.
 */
async function usdcAccountFor(conn: FinaliseConn, payer: PublicKey, mk: MarketInfo, owner: PublicKey) {
  const ata = usdcAta(mk, owner);
  const info = await conn.getAccountInfo(ata, "confirmed");
  if (!info || info.owner.equals(SystemProgram.programId)) {
    return { account: ata, instructions: [createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mk.usdcMint, mk.tokenProgram)], signers: [] as Keypair[] };
  }
  const d = Buffer.from(info.data);
  const usable = info.owner.equals(mk.tokenProgram) && d.length >= 64 && d.subarray(0, 32).equals(mk.usdcMint.toBuffer()) && d.subarray(32, 64).equals(owner.toBuffer());
  if (usable) return { account: ata, instructions: [] as TransactionInstruction[], signers: [] as Keypair[] };
  const fresh = Keypair.generate();
  return {
    account: fresh.publicKey,
    signers: [fresh],
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: fresh.publicKey,
        space: ACCOUNT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
        programId: mk.tokenProgram,
      }),
      createInitializeAccount3Instruction(fresh.publicKey, mk.usdcMint, owner, mk.tokenProgram),
    ],
  };
}

export type FinaliseConn = Pick<Connection, "getAccountInfo" | "getMinimumBalanceForRentExemption">;

/**
 * Finalise with the token accounts it pays into, which the payer prepares. A leg with no candidate voids and never
 * reads submitter_usdc, so the dealer's account fills the slot. `signers` must sign alongside the payer.
 */
export async function finaliseInstructions(conn: FinaliseConn, programId: PublicKey, payer: PublicKey, market: PublicKey, mk: MarketInfo, leg: Leg) {
  const candidate = leg === "friday" ? mk.friday : mk.monday;
  const dealer = await usdcAccountFor(conn, payer, mk, mk.dealer);
  const submitter = candidate && !candidate.submitter.equals(mk.dealer) ? await usdcAccountFor(conn, payer, mk, candidate.submitter) : null;
  return {
    instructions: [
      ...dealer.instructions,
      ...(submitter?.instructions ?? []),
      finaliseInstruction(programId, payer, market, mk, leg, submitter?.account ?? dealer.account, dealer.account),
    ],
    signers: [...dealer.signers, ...(submitter?.signers ?? [])],
  };
}

export function marketView(mk: MarketInfo): MarketView {
  const e = mk.eligibility;
  const params = (confCapBps: number) => ({ feedId: e.feedId, exponent: e.exponent, halfWindowUs: e.halfWindowUs, confCapBps, minPublishers: e.minPublishers });
  return {
    targetUs: { friday: e.fridayTargetUs, monday: e.mondayTargetUs },
    params: { friday: params(e.fridayConfCapBps), monday: params(e.mondayConfCapBps) },
    candidateFeedTsUs: { friday: mk.friday?.feedTsUs ?? null, monday: mk.monday?.feedTsUs ?? null },
    finalised: { friday: mk.state !== "Created", monday: mk.state === "MondayFinal" || mk.state === "Voided" },
    state: mk.state,
  };
}

/** The keeper's chain: the given payer signs and pays for reports and finalise calls. */
export function solanaChain(conn: Connection, programId: PublicKey, payer: Keypair): Chain {
  const read = async (market: string) => {
    const mk = await readMarket(conn, programId, new PublicKey(market));
    if (!mk) throw new Error(`market ${market} not found`);
    return mk;
  };
  return {
    readMarket: async (market) => marketView(await read(market)),
    submitReport: (market: string, leg: Leg, u: SignedUpdate) =>
      sendSubmitReport(conn, programId, payer, new PublicKey(market), leg, Buffer.from(u.messageHex, "hex")),
    async finalise(market, leg) {
      const mk = await read(market);
      const { instructions, signers } = await finaliseInstructions(conn, programId, payer.publicKey, new PublicKey(market), mk, leg);
      const tx = new Transaction().add(...instructions);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer, ...signers);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(`finalise_${leg} failed on landing: ${JSON.stringify(res.value.err)}`);
    },
  };
}
