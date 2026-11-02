// Creates one "<SYM>x (test)" mint per stock (Token-2022, 8 decimals, ScaledUiAmount multiplier 1.0, dealer as mint
// and multiplier authority) and, when there is none yet, "USDC (demo)" (6 decimals) with 10_000 minted to the dealer.
// Writes config/devnet.json, keeping what is already there:
//   testMints: { NVDA: { mint, decimals, program, scaledUiMultiplier }, TSLA: {...}, ... }
// An existing NVDA mint in the older nvdaxTest entry is reused as testMints.NVDA, so the NVDA sandbox and faucet keep
// their mint. Symbols that already have a test mint are skipped.
// Usage: RPC_URL=... DEALER_KEYPAIR=~/.config/solana/id.json node scripts/create-test-mints.ts [SYM ...]
//   With no symbols: every enabled stock in service/src/config.ts. --dry-run prints what it would create.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction, createMint, getMintLen,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { enabledMarkets, marketBySymbol } from "../service/src/config.ts";

const CONFIG = "config/devnet.json";

async function createScaledMint(conn: Connection, dealer: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const rent = await conn.getMinimumBalanceForRentExemption(len);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: dealer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeScaledUiAmountConfigInstruction(mint.publicKey, dealer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 8, dealer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, tx, [dealer, mint]);
  return mint.publicKey;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const named = args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
  const symbols = named.length ? named : enabledMarkets().map((m) => m.symbol);
  for (const s of symbols) if (!marketBySymbol(s)) throw new Error(`unknown symbol ${s}`);

  const out: any = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : { cluster: "devnet" };
  out.testMints ??= {};
  if (out.nvdaxTest?.mint && !out.testMints.NVDA) out.testMints.NVDA = { ...out.nvdaxTest };
  const todo = symbols.filter((s) => !out.testMints[s]);
  console.log(`creating test mints for: ${todo.join(", ") || "(none)"}${out.usdcDemo ? "" : " and USDC (demo)"}`);
  if (dryRun) return console.log("dry run: nothing sent");

  const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const keyPath = (process.env.DEALER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
  const dealer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  out.dealer ??= dealer.publicKey.toBase58();
  if (out.dealer !== dealer.publicKey.toBase58()) throw new Error(`${CONFIG} belongs to dealer ${out.dealer}`);

  const save = () => {
    mkdirSync("config", { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(out, null, 2) + "\n");
  };
  if (!out.usdcDemo) {
    // USDC (demo): classic SPL token, 6 decimals.
    const usdc: PublicKey = await createMint(conn, dealer, dealer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(conn, dealer, usdc, dealer.publicKey);
    await mintTo(conn, dealer, usdc, ata.address, dealer, 10_000n * 1_000_000n);
    out.usdcDemo = { mint: usdc.toBase58(), decimals: 6, program: TOKEN_PROGRAM_ID.toBase58(), dealerAta: ata.address.toBase58(), dealerBalance: 10_000 };
    save();
  }
  for (const sym of todo) {
    const mint = await createScaledMint(conn, dealer);
    out.testMints[sym] = { mint: mint.toBase58(), decimals: 8, program: TOKEN_2022_PROGRAM_ID.toBase58(), scaledUiMultiplier: 1.0 };
    if (sym === "NVDA" && !out.nvdaxTest) out.nvdaxTest = { ...out.testMints.NVDA };
    save(); // after each mint, so a failure part way keeps what was made
    console.log(`${sym}x (test): ${mint.toBase58()}`);
  }
  console.log(out);
}
main().catch((e) => { console.error(e); process.exit(1); });
