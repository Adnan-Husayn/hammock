// Test harness on LiteSVM. solana-bankrun was tried first and rejected: it does not run the
// Ed25519 precompile, so a forged signature passes and the Lazer verifier cannot be tested.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteSVM, Clock, FailedTransactionMetadata, TransactionMetadata } from "litesvm";
import { AnchorProvider, Program, Idl, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
  createAmountToUiAmountInstruction,
} from "@solana/spl-token";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAZER_PROGRAM_ID = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
export const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
export const LAZER_TREASURY = new PublicKey("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7");
export const TREASURY_LAMPORTS = 10_000_000;

const idl = JSON.parse(readFileSync(resolve(ROOT, "idl/gap_cover.json"), "utf8")) as Idl;

function loadDumpedAccount(svm: LiteSVM, file: string, lamports?: number) {
  const { pubkey, account } = JSON.parse(readFileSync(resolve(ROOT, file), "utf8"));
  svm.setAccount(new PublicKey(pubkey), {
    lamports: lamports ?? account.lamports,
    data: Buffer.from(account.data[0], "base64"),
    owner: new PublicKey(account.owner),
    executable: account.executable,
    rentEpoch: 0,
  });
}

export type SendResult = TransactionMetadata | FailedTransactionMetadata;
export const failed = (r: SendResult): r is FailedTransactionMetadata => r instanceof FailedTransactionMetadata;

/** Sign with the harness payer (plus extra signers) and send. Returns the raw LiteSVM result. */
export function sendTx(svm: LiteSVM, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []): SendResult {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers);
  const r = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return r;
}

function mustSend(svm: LiteSVM, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const r = sendTx(svm, payer, ixs, signers);
  if (failed(r)) throw new Error(`transaction failed: ${r.toString()}\n${r.meta().logs().join("\n")}`);
  return r;
}

/** Minimal Anchor provider that routes transactions into LiteSVM. */
class LiteSvmProvider extends AnchorProvider {
  constructor(public svm: LiteSVM, payer: Keypair) {
    super(new Connection("http://127.0.0.1:1"), new Wallet(payer), { commitment: "confirmed" });
  }
  override async sendAndConfirm(tx: Transaction | VersionedTransaction, signers: Keypair[] = []): Promise<string> {
    if (tx instanceof VersionedTransaction) throw new Error("versioned transactions not supported by harness");
    const r = sendTx(this.svm, (this.wallet as Wallet).payer, tx.instructions, signers);
    if (failed(r)) throw new Error(`transaction failed: ${r.toString()}\n${r.meta().logs().join("\n")}`);
    return Buffer.from(r.signature()).toString("hex");
  }
}

const payers = new WeakMap<LiteSVM, Keypair>();

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness() {
  const context = new LiteSVM().withSigverify(true).withPrecompiles();
  context.addProgramFromFile(new PublicKey(idl.address), resolve(ROOT, "target/deploy/gap_cover.so"));
  context.addProgramFromFile(LAZER_PROGRAM_ID, resolve(ROOT, "fixtures/lazer/pytd2.so"));
  // LiteSVM bundles a Token-2022 build; replace it with the devnet dump so ScaledUiAmount matches mainnet behaviour.
  context.addProgramFromFile(TOKEN_2022_PROGRAM_ID, resolve(ROOT, "fixtures/token2022.so"));
  loadDumpedAccount(context, "fixtures/lazer/storage.json");
  loadDumpedAccount(context, "fixtures/lazer/treasury.json", TREASURY_LAMPORTS);

  const payer = Keypair.generate();
  context.airdrop(payer.publicKey, 100_000_000_000n);
  payers.set(context, payer);
  const provider = new LiteSvmProvider(context, payer);
  const program = new Program(idl, provider);

  // Start at the fixture capture time (29 Oct 2026) so the storage account's signer expiries apply as on devnet.
  const fixtureUs = BigInt(JSON.parse(readFileSync(resolve(ROOT, "fixtures/pyth/regular-2026-10-29.json"), "utf8")).parsed.timestampUs);
  await warpTo(context, Number(fixtureUs / 1_000_000n));

  return { context, provider, program, payer, usdcMint: null as PublicKey | null, clock: context.getClock() };
}

export async function warpTo(context: LiteSVM, unixSeconds: number): Promise<void> {
  const c = context.getClock();
  const slot = c.slot + 1n;
  context.warpToSlot(slot);
  context.setClock(new Clock(slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(unixSeconds)));
}

export function fixturePayload(name: string): Buffer {
  const j = JSON.parse(readFileSync(resolve(ROOT, `fixtures/pyth/${name}.json`), "utf8"));
  const buf = Buffer.from(j.solana.data, "hex");
  if (buf.length !== 158) throw new Error(`fixture ${name}: expected 158 bytes, got ${buf.length}`);
  return buf;
}

// Harness payer per LiteSVM instance; it is the mint authority for scaled mints.
function payerOf(context: LiteSVM): Keypair {
  const p = payers.get(context);
  if (!p) throw new Error("context was not created by startHarness");
  return p;
}

export async function createScaledMint(context: LiteSVM, opts: { decimals: number; multiplier: number }): Promise<PublicKey> {
  const payer = payerOf(context);
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  mustSend(
    context,
    payer,
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports: Number(context.minimumBalanceForRentExemption(BigInt(space))), programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeScaledUiAmountConfigInstruction(mint.publicKey, payer.publicKey, opts.multiplier, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, opts.decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ],
    [mint],
  );
  return mint.publicKey;
}

export async function scheduleMultiplier(context: LiteSVM, mint: PublicKey, newMultiplier: number, effectiveTs: number): Promise<void> {
  const payer = payerOf(context);
  mustSend(context, payer, [createUpdateMultiplierDataInstruction(mint, payer.publicKey, newMultiplier, BigInt(effectiveTs), [], TOKEN_2022_PROGRAM_ID)]);
}

/** UI amount as computed on-chain by Token-2022's AmountToUiAmount at the current harness clock. */
export async function uiAmount(context: LiteSVM, mint: PublicKey, amount: bigint): Promise<string> {
  const r = sendTx(context, payerOf(context), [createAmountToUiAmountInstruction(mint, amount, TOKEN_2022_PROGRAM_ID)]);
  if (failed(r)) throw new Error(`AmountToUiAmount failed: ${r.toString()}`);
  return Buffer.from(r.returnData().data()).toString("utf8");
}
