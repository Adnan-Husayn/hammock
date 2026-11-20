// Prints a market's state, both marks, the gap and the payout. Read-only.
// Usage: node scripts/read-market.ts <market address> [more addresses]
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";

const idl = JSON.parse(readFileSync(new URL("../idl/gap_cover.json", import.meta.url), "utf8"));
const coder = new BorshAccountsCoder(idl);
const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const str = (v: unknown): unknown =>
  v && typeof v === "object" && "toString" in v && (v as any).constructor?.name === "BN" ? (v as any).toString()
  : v instanceof PublicKey ? v.toBase58()
  : Array.isArray(v) ? v.map(str)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)]))
  : v;

for (const a of process.argv.slice(2)) {
  const info = await conn.getAccountInfo(new PublicKey(a));
  if (!info) { console.log(a, "not found"); continue; }
  const m = coder.decode("Market", info.data);
  const exp = 10 ** Number(m.exponent);
  const f = m.friday ? Number(m.friday.price) * exp : null;
  const mo = m.monday ? Number(m.monday.price) * exp : null;
  console.log({
    market: a, feedId: m.feed_id, state: Object.keys(m.state)[0],
    friday: str(m.friday), monday: str(m.monday), fridayPrice: f, mondayPrice: mo,
    gapPct: f && mo ? +((1 - mo / f) * 100).toFixed(3) : null,
    payoutPerContractUsdc: Number(m.payout_per_contract) / 1e6,
    contractsSold: str(m.contracts_sold), totalPremiumsUsdc: Number(m.total_premiums) / 1e6,
    settledAt: Number(m.settled_at) ? new Date(Number(m.settled_at) * 1000).toISOString() : null,
  });
}
