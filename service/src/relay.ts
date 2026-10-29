import { ComputeBudgetProgram, Ed25519Program, PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import { INLINE_MSG, INLINE_PK, INLINE_SIG, QUOTE_LEN } from "./quote.ts";

/**
 * Fee-payer relay for sandbox judge flows (spec section 11). The service pays fees only for a transaction it fully
 * understands. Rules, all required:
 *  - legacy transaction, fee payer is the relay key, at most 3 instructions
 *  - exactly one gap_cover instruction, and it is `buy`, `claim` or `refund`, on a sandbox market
 *  - `buy` sits at index 1 with an inline Ed25519 quote instruction at index 0 (the only place Ed25519 is allowed);
 *    `claim` and `refund` carry no Ed25519 instruction
 *  - Compute Budget: only SetComputeUnitLimit, at most once, at most 400_000. No priority fee (the relay would pay
 *    it) and no heap request. Without a limit instruction the runtime default for one program instruction applies
 *    (200_000), which is inside the cap.
 *  - any other program id is refused
 *  - the relay key appears in no instruction's accounts, so it can only pay the fee, never act as buyer or owner
 *  - the only signers are the relay key and the user named as the instruction's first account
 */
export const MAX_INSTRUCTIONS = 3;
export const MAX_COMPUTE_UNITS = 400_000;
export const RELAYABLE = {
  buy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  claim: Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]),
  refund: Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]),
} as const;
export type RelayKind = keyof typeof RELAYABLE;

export class RelayRefused extends Error {}

export type RelayContext = {
  programId: PublicKey;
  feePayer: PublicKey;
  isSandboxMarket(market: PublicKey): Promise<boolean>;
};

const refuse = (why: string): never => {
  throw new RelayRefused(why);
};

/** Validates a serialized, unsigned-by-us transaction. Returns the parsed transaction and what it does. */
export async function checkRelay(raw: Buffer, ctx: RelayContext): Promise<{ tx: Transaction; kind: RelayKind; user: PublicKey; market: PublicKey }> {
  if (raw.length === 0 || raw.length > 1232) refuse("bad transaction size");
  // Versioned messages set the top bit of the first message byte; only legacy transactions are relayed.
  let n = 0, shift = 0, o = 0;
  for (;;) { const b = raw[o++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; if (o > 3) refuse("bad signature count"); }
  if (raw.length <= o + 64 * n || raw[o + 64 * n] & 0x80) refuse("not a legacy transaction");
  let tx: Transaction;
  try {
    tx = Transaction.from(raw);
  } catch {
    return refuse("not a legacy transaction");
  }
  const msg = tx.compileMessage();
  if (msg.header.numRequiredSignatures === 0) refuse("no signers");
  if (!tx.feePayer?.equals(ctx.feePayer)) refuse("fee payer must be the relay key");

  const ixs = tx.instructions;
  if (ixs.length === 0 || ixs.length > MAX_INSTRUCTIONS) refuse(`at most ${MAX_INSTRUCTIONS} instructions`);

  let program: { index: number; kind: RelayKind } | null = null;
  let edIndex = -1;
  let cuLimitSeen = false;
  ixs.forEach((ix, i) => {
    if (ix.programId.equals(ctx.programId)) {
      if (program) refuse("only one gap_cover instruction");
      const disc = ix.data.subarray(0, 8);
      const kind = (Object.keys(RELAYABLE) as RelayKind[]).find((k) => RELAYABLE[k].equals(disc));
      if (!kind || ix.data.length !== 8) refuse("only buy, claim or refund");
      program = { index: i, kind: kind! };
    } else if (ix.programId.equals(Ed25519Program.programId)) {
      if (edIndex >= 0 || i !== 0) refuse("Ed25519 only at index 0");
      if (ix.keys.length !== 0) refuse("Ed25519 takes no accounts");
      const d = ix.data;
      const ok =
        d.length === INLINE_MSG + QUOTE_LEN && d[0] === 1 &&
        d.readUInt16LE(2) === INLINE_SIG && d.readUInt16LE(6) === INLINE_PK && d.readUInt16LE(10) === INLINE_MSG &&
        d.readUInt16LE(12) === QUOTE_LEN && [4, 8, 14].every((o) => d.readUInt16LE(o) === 0xffff);
      if (!ok) refuse("Ed25519 instruction is not an inline quote");
      edIndex = i;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (ix.keys.length !== 0) refuse("compute budget takes no accounts");
      // SetComputeUnitLimit = 2, u32 units
      if (ix.data.length !== 5 || ix.data[0] !== 2) refuse("only SetComputeUnitLimit is allowed");
      if (cuLimitSeen) refuse("one compute unit limit only");
      cuLimitSeen = true;
      if (ix.data.readUInt32LE(1) > MAX_COMPUTE_UNITS) refuse(`compute limit above ${MAX_COMPUTE_UNITS}`);
    } else {
      refuse(`program ${ix.programId.toBase58()} is not allowed`);
    }
  });
  if (!program) return refuse("no gap_cover instruction");
  const { index, kind } = program as { index: number; kind: RelayKind };
  if (kind === "buy" ? !(edIndex === 0 && index === 1) : edIndex >= 0) refuse("buy needs its quote at index 0 and buy at index 1");

  const ix = ixs[index];
  if (ix.keys.length < 2) refuse("missing accounts");
  const user = ix.keys[0].pubkey;
  const market = ix.keys[1].pubkey;
  if (!ix.keys[0].isSigner) refuse("user must sign");
  for (const k of ixs.flatMap((x) => x.keys)) if (k.pubkey.equals(ctx.feePayer)) refuse("relay key may only pay fees");

  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
  if (signers.length !== 2 || !signers[0].equals(ctx.feePayer) || !signers[1].equals(user)) refuse("signers must be the relay key and the user");

  if (!(await ctx.isSandboxMarket(market))) refuse("relay serves sandbox markets only");
  return { tx, kind, user, market };
}

/** Checks, then partially signs as fee payer. The user's wallet adds its signature and sends. */
export async function relay(raw: Buffer, ctx: RelayContext, feePayer: Keypair): Promise<Buffer> {
  if (!feePayer.publicKey.equals(ctx.feePayer)) throw new Error("relay key mismatch");
  const { tx } = await checkRelay(raw, ctx);
  tx.partialSign(feePayer);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
