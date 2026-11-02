import { Keypair, PublicKey } from "@solana/web3.js";
import { vi } from "vitest";
import type { AppDeps, QuoteJson } from "../lib/api";
import type { MarketInfo } from "../lib/program";

export const pk = () => Keypair.generate().publicKey;
export const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);

export function market(o: Partial<MarketInfo> = {}): MarketInfo {
  return {
    dealer: pk(), feedId: 1314, usdcMint: pk(), tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), escrow: pk(), collateralReserve: pk(),
    fridayTargetUs: BigInt(NOW - 86_400_000) * 1000n, mondayTargetUs: BigInt(NOW + 2 * 86_400_000) * 1000n,
    buyingCloseTs: BigInt(Math.floor(NOW / 1000) + 86_400), bandLowerBps: 100, bandUpperBps: 500,
    fridayConfCapBps: 10, mondayConfCapBps: 20, minPublishers: 10, maxContracts: 10_000, sandbox: false, sandboxMode: "gap",
    state: "FridayFinal", friday: { price: 18_000_000n, feedTsUs: BigInt(NOW - 86_400_000) * 1000n, submitter: pk() }, monday: null,
    contractsSold: 0, totalPremiums: 0n, activePositions: 0, payoutPerContract: 0n, buyingClosed: false, settledAt: 0n, ...o,
  };
}

export function quote(o: Partial<QuoteJson> = {}): QuoteJson {
  return {
    market: pk().toBase58(), buyer: pk().toBase58(), contracts: 200, premiumPerContract: "120000", totalPremium: "24000000",
    expiry: Math.floor(NOW / 1000) + 60, nonce: "1", ed25519Data: "", inputs: { fridayRef: 180, price: 180, m: 1, sold: 0, max: 10000, base: 0.09, uncertainty: 0.0275, utilisation: 0, reserve: 0.002, units: 120000 }, ...o,
  };
}

export function deps(o: { market?: MarketInfo | null; usdc?: bigint; wallet?: boolean; real?: boolean } = {}): AppDeps {
  const wallet = o.wallet === false ? null : { publicKey: pk(), signTransaction: vi.fn(async (_t: any) => ({ serialize: () => new Uint8Array() }) as any) };
  return {
    programId: pk(),
    realMarket: o.real === false || o.market === null ? null : pk(),
    wallet,
    now: () => NOW,
    service: {
      quote: vi.fn(async () => quote()),
      startSandbox: vi.fn(async () => ({ market: pk().toBase58(), fridayPrice: "18000000", mode: "gap", relayPayer: pk().toBase58() })),
      bell: vi.fn(async () => ({ mode: "gap", fallBps: 200, mondayPrice: "17640000" })),
      relayPayer: vi.fn(async () => pk().toBase58()),
      relay: vi.fn(async (t: string) => t),
      faucet: vi.fn(async () => "sig"),
      archive: vi.fn(async () => []),
    },
    chain: {
      readMarket: vi.fn(async () => o.market ?? null),
      readPosition: vi.fn(async () => null),
      usdcBalance: vi.fn(async () => o.usdc ?? 1_000_000_000n),
      blockhash: vi.fn(async () => "11111111111111111111111111111111"),
      sendRaw: vi.fn(async () => "sig"),
      referencePrice: vi.fn(async () => 176),
    },
  };
}

export const OPEN = /\bopen\b/i;
