import { PublicKey, Transaction } from "@solana/web3.js";
import type { AppDeps } from "./api";

const toB64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Sandbox: the service pays the fee. It checks and partially signs; the wallet adds its own signature; then send.
 * Real market: the wallet pays its own fee and signs alone.
 */
export async function signAndSend(deps: AppDeps, build: (feePayer: PublicKey, blockhash: string) => Transaction, sandbox: boolean): Promise<string> {
  const w = deps.wallet;
  if (!w) throw new Error("Connect a wallet first");
  const blockhash = await deps.chain.blockhash();
  let tx: Transaction;
  if (sandbox) {
    const payer = new PublicKey(await deps.service.relayPayer());
    const unsigned = build(payer, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false });
    tx = Transaction.from(fromB64(await deps.service.relay(toB64(unsigned))));
  } else {
    tx = build(w.publicKey, blockhash);
  }
  const signed = await w.signTransaction(tx);
  return deps.chain.sendRaw(signed.serialize());
}
