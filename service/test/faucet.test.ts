import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FAUCET_LAMPORTS, FAUCET_SOL_BELOW_LAMPORTS, FAUCET_SOL_PER_HOUR_LAMPORTS, HourlyCap, faucet, type DevnetSetup } from "../src/sandbox.ts";
import { FAUCET_COOLDOWN_MS, PersistedCooldown, serviceServer } from "../src/server.ts";

const dealer = Keypair.generate();
const faucetKey = Keypair.generate();

function setup(walletLamports: number) {
  const sent: Transaction[] = [];
  const conn = {
    getBalance: async () => walletLamports,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => (sent.push(Transaction.from(raw)), "sig"),
    confirmTransaction: async () => ({ value: { err: null } }),
  } as any;
  const s: DevnetSetup = {
    conn, programId: Keypair.generate().publicKey, dealer, demo: Keypair.generate(), quoteKey: dealer.publicKey,
    usdcMint: Keypair.generate().publicKey, stockMint: Keypair.generate().publicKey,
  };
  return { s, sent };
}
const solTransfers = (tx: Transaction) => tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId));
const lamportsOf = (tx: Transaction) => solTransfers(tx).reduce((a, i) => a + Number(i.data.readBigUInt64LE(4)), 0);

describe("faucet SOL", () => {
  it("sends SOL from the faucet key, never the dealer, to an empty wallet; the faucet key pays fees", async () => {
    const { s, sent } = setup(0);
    const r = await faucet(s, Keypair.generate().publicKey, { faucetKey });
    expect(r.solLamports).toBe(FAUCET_LAMPORTS);
    const tx = sent[0];
    expect(tx.feePayer!.equals(faucetKey.publicKey)).toBe(true);
    expect(solTransfers(tx)).toHaveLength(1);
    expect(solTransfers(tx)[0].keys[0].pubkey.equals(faucetKey.publicKey)).toBe(true);
    expect(lamportsOf(tx)).toBe(FAUCET_LAMPORTS);
    // dealer signs as mint authority but funds nothing writable
    for (const ix of tx.instructions) for (const k of ix.keys) if (k.pubkey.equals(dealer.publicKey)) expect(k.isWritable).toBe(false);
  });

  it("sends no SOL to a wallet that already holds 0.003 SOL or more", async () => {
    const { s, sent } = setup(FAUCET_SOL_BELOW_LAMPORTS);
    const r = await faucet(s, Keypair.generate().publicKey, { faucetKey });
    expect(r.solLamports).toBe(0);
    expect(solTransfers(sent[0])).toHaveLength(0);
  });

  it("refuses SOL when FAUCET_KEYPAIR is unset, and still sends tokens", async () => {
    const { s, sent } = setup(0);
    const r = await faucet(s, Keypair.generate().publicKey, { faucetKey: null });
    expect(r.solLamports).toBe(0);
    expect(solTransfers(sent[0])).toHaveLength(0);
    expect(sent[0].instructions).toHaveLength(4);
  });

  it("stops SOL at the hourly cap across all wallets and resumes after an hour", async () => {
    const { s, sent } = setup(0);
    let t = 0;
    const solCap = new HourlyCap(FAUCET_SOL_PER_HOUR_LAMPORTS);
    const n = FAUCET_SOL_PER_HOUR_LAMPORTS / FAUCET_LAMPORTS;
    for (let i = 0; i < n; i++) expect((await faucet(s, Keypair.generate().publicKey, { faucetKey, solCap, nowMs: () => t })).solLamports).toBe(FAUCET_LAMPORTS);
    expect((await faucet(s, Keypair.generate().publicKey, { faucetKey, solCap, nowMs: () => t })).solLamports).toBe(0);
    expect(lamportsOf(sent.at(-1)!)).toBe(0);
    t = 3_600_000;
    expect((await faucet(s, Keypair.generate().publicKey, { faucetKey, solCap, nowMs: () => t })).solLamports).toBe(FAUCET_LAMPORTS);
  });
});

describe("faucet cooldown persistence", () => {
  it("survives a restart, and a new store reads the old file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "faucet-")), "faucet-cooldown.json");
    const wallet = Keypair.generate().publicKey.toBase58();
    let t = 1_000;
    const serve = async (fn: (u: string) => Promise<void>) => {
      const srv = serviceServer({
        quoter: {} as any, sandbox: {} as any, relayPayer: PublicKey.default, relay: async () => { throw 0; },
        faucet: async () => "sig", relayBalance: async () => 0, nowMs: () => t,
        faucetCooldown: new PersistedCooldown(path, FAUCET_COOLDOWN_MS),
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      try { await fn(`http://127.0.0.1:${(srv.address() as any).port}`); } finally { srv.close(); }
    };
    const post = (u: string) => fetch(`${u}/faucet`, { method: "POST", body: JSON.stringify({ wallet }) }).then((r) => r.status);
    await serve(async (u) => expect(await post(u)).toBe(200));
    expect(JSON.parse(readFileSync(path, "utf8"))[wallet]).toBe(1_000);
    await serve(async (u) => expect(await post(u)).toBe(429)); // "restart": fresh server, same file
    t += FAUCET_COOLDOWN_MS;
    await serve(async (u) => expect(await post(u)).toBe(200));
  });

  it("drops expired entries on write", () => {
    const path = join(mkdtempSync(join(tmpdir(), "faucet-")), "c.json");
    const c = new PersistedCooldown(path, 100);
    c.set("a", 0);
    c.set("b", 150);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["b"]);
  });
});
