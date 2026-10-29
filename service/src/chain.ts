import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import { LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY } from "./config.ts";
import type { Leg } from "./archive.ts";

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
    return !res.value.err;
  } catch (e: any) {
    // Only a report-specific rejection returns false; any other failure throws so the keeper retries.
    const logs: string[] | undefined = Array.isArray(e?.logs) ? e.logs : Array.isArray(e?.transactionLogs) ? e.transactionLogs : undefined;
    if (logs && isReportRejection(logs)) return false;
    throw e;
  }
}
