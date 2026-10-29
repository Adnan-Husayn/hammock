import { Connection, PublicKey } from "@solana/web3.js";

// Mainnet. NVDAx is the xStocks NVIDIA token (Token-2022, 8 decimals, scaled-UI multiplier).
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const PROBE_USDC = 1000;

export type Reference = { price: number; roundTripBps: number; multiplier: number; decimals: number };
export type MintInfo = { decimals: number; multiplier: number; newMultiplier: number; newMultiplierEffectiveTs: number };

export type JupiterDeps = {
  fetchJson?: (url: string) => Promise<any>;
  readMint?: () => Promise<MintInfo>;
  nowS?: () => number;
};

async function defaultFetchJson(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Jupiter HTTP ${r.status}`);
  return r.json();
}

/** Reads decimals and the ScaledUiAmount config of the mainnet NVDAx mint. */
export async function readMainnetMint(rpcUrl = process.env.MAINNET_RPC_URL ?? MAINNET_RPC): Promise<MintInfo> {
  const conn = new Connection(rpcUrl, "confirmed");
  const acct = await conn.getParsedAccountInfo(new PublicKey(NVDAX_MINT));
  const info = (acct.value?.data as any)?.parsed?.info;
  if (!info) throw new Error("NVDAx mint not found");
  const ext = (info.extensions ?? []).find((e: any) => e.extension === "scaledUiAmountConfig")?.state;
  return {
    decimals: info.decimals,
    multiplier: ext ? Number(ext.multiplier) : 1,
    newMultiplier: ext ? Number(ext.newMultiplier) : 1,
    newMultiplierEffectiveTs: ext ? Number(ext.newMultiplierEffectiveTimestamp) : 0,
  };
}

export function effectiveMultiplier(m: MintInfo, nowS: number): number {
  return nowS >= m.newMultiplierEffectiveTs ? m.newMultiplier : m.multiplier;
}

const quoteUrl = (input: string, output: string, amount: bigint) =>
  `${JUPITER_QUOTE_URL}?inputMint=${input}&outputMint=${output}&amount=${amount}&swapMode=ExactIn&slippageBps=50`;

/**
 * Spec section 7: quote 1,000 USDC -> NVDAx (t raw units), then t NVDAx -> USDC (u).
 * shares = t * k / 10^d, price = 1000 / shares, round_trip_bps = (1000 - u) * 10_000 / 1000.
 * Returns null when Jupiter has no route or any call fails (that also trips the freeze).
 */
export async function nvdaxReference(deps: JupiterDeps = {}): Promise<Reference | null> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const readMint = deps.readMint ?? (() => readMainnetMint());
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  try {
    const mint = await readMint();
    const buy = await fetchJson(quoteUrl(USDC_MINT, NVDAX_MINT, BigInt(PROBE_USDC * 1_000_000)));
    if (!buy?.outAmount) return null;
    const t = BigInt(buy.outAmount);
    if (t <= 0n) return null;
    const sell = await fetchJson(quoteUrl(NVDAX_MINT, USDC_MINT, t));
    if (!sell?.outAmount) return null;
    const u = Number(BigInt(sell.outAmount)) / 1_000_000;
    const k = effectiveMultiplier(mint, nowS());
    const shares = (Number(t) * k) / 10 ** mint.decimals;
    if (!(shares > 0)) return null;
    return { price: PROBE_USDC / shares, roundTripBps: ((PROBE_USDC - u) * 10_000) / PROBE_USDC, multiplier: k, decimals: mint.decimals };
  } catch {
    return null;
  }
}
