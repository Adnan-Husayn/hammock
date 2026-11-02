// End-to-end sandbox run against the hosted service with a throwaway wallet, using the app's own transaction builders.
// Usage: node --experimental-strip-types scripts/e2e-sandbox.ts [gap|multiplierVoid] [SYMBOL]   (default gap NVDA)
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildBuyTx, buildClaimTx, buildRefundTx, decodeMarket } from "../app/src/lib/program.ts";

const BASE = process.env.SERVICE_URL ?? "https://ambergris-moonrise-938.fly.dev";
const programId = new PublicKey("HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g");
const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const mode = process.argv[2] ?? "gap";
const symbol = (process.argv[3] ?? "NVDA").toUpperCase();
const user = Keypair.generate();

async function j(r: Response) {
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.url} ${r.status}: ${v.error ?? JSON.stringify(v)}`);
  return v;
}
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function relayed(build: (feePayer: PublicKey, blockhash: string) => Transaction) {
  const { relayPayer } = await fetch(`${BASE}/relay`).then(j);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const t = build(new PublicKey(relayPayer), blockhash);
  t.partialSign(user);
  const { transaction } = await post("/relay", { transaction: t.serialize({ requireAllSignatures: false }).toString("base64") });
  const sig = await conn.sendRawTransaction(Buffer.from(transaction, "base64"));
  const r = await conn.confirmTransaction(sig, "confirmed");
  if (r.value.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(r.value.err)}`);
  return sig;
}
async function balance(mint: PublicKey) {
  const a = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint });
  return a.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

console.log("wallet", user.publicKey.toBase58());
await post("/faucet", { wallet: user.publicKey.toBase58(), symbol });
const start = await post("/sandbox/start", { mode, symbol });
const market = new PublicKey(start.market);
console.log("market", start.market, "friday", start.fridayPrice);
await sleep(2000);
const read = async () => decodeMarket((await conn.getAccountInfo(market, "confirmed"))!.data);
let info = await read();
console.log("usdc after faucet", await balance(info.usdcMint));
const q = await fetch(`${BASE}/quote?${new URLSearchParams({ market: start.market, buyer: user.publicKey.toBase58(), contracts: "200" })}`).then(j);
console.log("premium", q.totalPremium);
const ctx = (feePayer: PublicKey, blockhash: string) => ({ programId, market, info, user: user.publicKey, feePayer, blockhash });
console.log("buy", await relayed((f, b) => buildBuyTx(ctx(f, b), q.ed25519Data)));
console.log("usdc after buy", await balance(info.usdcMint));
const bell = await post("/sandbox/bell", { market: start.market });
console.log("bell", JSON.stringify(bell));
await sleep(2000);
info = await read();
const settle = mode === "gap" ? buildClaimTx : buildRefundTx;
console.log(mode === "gap" ? "claim" : "refund", await relayed((f, b) => settle(ctx(f, b))));
console.log("usdc final", await balance(info.usdcMint));
