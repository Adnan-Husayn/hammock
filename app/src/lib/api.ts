import type { PublicKey, Transaction } from "@solana/web3.js";
import type { MarketInfo, PositionInfo } from "./program";

export type QuoteJson = {
  market: string;
  buyer: string;
  contracts: number;
  premiumPerContract: string;
  totalPremium: string;
  expiry: number;
  nonce: string;
  ed25519Data: string;
  inputs: { fridayRef: number | null; price: number | null; m: number; sold: number; max: number; base: number; uncertainty: number; utilisation: number; reserve: number; units: number };
};

export type ArchiveUpdate = {
  feedTsUs: string;
  timestampUs: string;
  price: string;
  exponent: number;
  confidence: string;
  publishers: number;
  session: string;
  hash: string;
};

export type ServiceApi = {
  quote(market: string, buyer: string, contracts: number): Promise<QuoteJson>;
  startSandbox(mode: "gap" | "multiplierVoid"): Promise<{ market: string; fridayPrice: string; mode: string; relayPayer: string }>;
  bell(market: string): Promise<{ mode: string; fallBps: number | null; mondayPrice: string }>;
  relayPayer(): Promise<string>;
  relay(txB64: string): Promise<string>;
  faucet(wallet: string): Promise<string>;
  archive(market: string, leg: "friday" | "monday"): Promise<ArchiveUpdate[]>;
};

export type ChainApi = {
  readMarket(market: PublicKey): Promise<MarketInfo | null>;
  readPosition(market: PublicKey, owner: PublicKey): Promise<PositionInfo | null>;
  usdcBalance(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<bigint>;
  blockhash(): Promise<string>;
  sendRaw(raw: Uint8Array): Promise<string>;
  /** Live NVDAx reference price in USD, for the locked-view estimate. */
  referencePrice(): Promise<number | null>;
};

/** The connected wallet. The app never holds a private key; signing happens in the wallet. */
export type WalletLike = { publicKey: PublicKey; signTransaction(tx: Transaction): Promise<Transaction> };

export type AppDeps = {
  service: ServiceApi;
  chain: ChainApi;
  wallet: WalletLike | null;
  programId: PublicKey;
  /** This weekend's real market, or null when none is configured. */
  realMarket: PublicKey | null;
  now?: () => number;
};

async function json(r: Response) {
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error ?? `HTTP ${r.status}`);
  return v;
}

export function httpService(base: string, archiveBase = base): ServiceApi {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(json);
  return {
    quote: (market, buyer, contracts) =>
      fetch(`${base}/quote?${new URLSearchParams({ market, buyer, contracts: String(contracts) })}`).then(json),
    startSandbox: (mode) => post("/sandbox/start", { mode }),
    bell: (market) => post("/sandbox/bell", { market }),
    relayPayer: () => fetch(`${base}/relay`).then(json).then((v) => v.relayPayer),
    relay: (transaction) => post("/relay", { transaction }).then((v) => v.transaction),
    faucet: (wallet) => post("/faucet", { wallet }).then((v) => v.signature),
    archive: (market, leg) => fetch(`${archiveBase}/archive/${market}/${leg}`).then(json).then((v) => v.updates ?? []),
  };
}
