// Creates "NVDAx (test)" (Token-2022, 8 decimals, ScaledUiAmount multiplier 1.0) and "USDC (demo)" (6 decimals),
// mints the dealer 10_000 demo USDC, and writes config/devnet.json.
// Usage: RPC_URL=... DEALER_KEYPAIR=~/.config/solana/id.json node scripts/create-test-mints.ts
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

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const keyPath = (process.env.DEALER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
const dealer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const conn = new Connection(RPC, "confirmed");

async function main() {
  if (existsSync("config/devnet.json") && process.env.FORCE !== "1") {
    throw new Error("config/devnet.json exists; set FORCE=1 to create new mints");
  }
  // NVDAx (test): Token-2022 with ScaledUiAmount, multiplier 1.0, authorities = dealer.
  const nvdax = Keypair.generate();
  const len = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const rent = await conn.getMinimumBalanceForRentExemption(len);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: dealer.publicKey, newAccountPubkey: nvdax.publicKey, space: len, lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeScaledUiAmountConfigInstruction(nvdax.publicKey, dealer.publicKey, 1.0, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(nvdax.publicKey, 8, dealer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, tx, [dealer, nvdax]);

  // USDC (demo): classic SPL token, 6 decimals.
  const usdc: PublicKey = await createMint(conn, dealer, dealer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  const ata = await getOrCreateAssociatedTokenAccount(conn, dealer, usdc, dealer.publicKey);
  await mintTo(conn, dealer, usdc, ata.address, dealer, 10_000n * 1_000_000n);

  const out = {
    cluster: "devnet",
    dealer: dealer.publicKey.toBase58(),
    nvdaxTest: { mint: nvdax.publicKey.toBase58(), decimals: 8, program: TOKEN_2022_PROGRAM_ID.toBase58(), scaledUiMultiplier: 1.0 },
    usdcDemo: { mint: usdc.toBase58(), decimals: 6, program: TOKEN_PROGRAM_ID.toBase58(), dealerAta: ata.address.toBase58(), dealerBalance: 10_000 },
  };
  mkdirSync("config", { recursive: true });
  writeFileSync("config/devnet.json", JSON.stringify(out, null, 2) + "\n");
  console.log(out);
}
main().catch((e) => { console.error(e); process.exit(1); });
