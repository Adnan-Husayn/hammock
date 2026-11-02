// Stocks the app can show. Mirrors service/src/config.ts MARKETS (symbol, Pyth Pro feed id, mainnet xStocks mint).
// The picker shows the enabled ones: VITE_SYMBOLS (comma list) when set, otherwise DEFAULT_SYMBOLS.
export type Stock = { symbol: string; feedId: number; mainnetMint: string };

export const ALL_STOCKS: readonly Stock[] = [
  { symbol: "NVDA", feedId: 1314, mainnetMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
  { symbol: "TSLA", feedId: 1435, mainnetMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB" },
  { symbol: "SPY", feedId: 1398, mainnetMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { symbol: "AAPL", feedId: 922, mainnetMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
  { symbol: "GOOGL", feedId: 1163, mainnetMint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN" },
  { symbol: "MSFT", feedId: 1292, mainnetMint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
  { symbol: "META", feedId: 1272, mainnetMint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu" },
  { symbol: "QQQ", feedId: 1363, mainnetMint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ" },
  { symbol: "AMZN", feedId: 954, mainnetMint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" },
];

export const DEFAULT_SYMBOLS = ["NVDA", "TSLA", "SPY", "AAPL"];

/** The enabled stocks, in the order given. Unknown symbols are dropped. */
export function enabledStocks(list?: string): Stock[] {
  const syms = list?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const want = syms?.length ? syms : DEFAULT_SYMBOLS;
  return want.map((s) => ALL_STOCKS.find((x) => x.symbol === s)).filter((x): x is Stock => !!x);
}

export const stockBySymbol = (symbol: string) => ALL_STOCKS.find((s) => s.symbol === symbol);
export const stockByFeed = (feedId: number) => ALL_STOCKS.find((s) => s.feedId === feedId);

/** The xStocks token name for a symbol, e.g. NVDAx. */
export const tokenName = (symbol: string) => `${symbol}x`;

/** "NVDA=<address>,TSLA=<address>" -> { NVDA: "<address>", ... }. */
export function parseMarketList(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (v ?? "").split(",")) {
    const [sym, addr] = part.split("=").map((x) => x?.trim());
    if (sym && addr) out[sym.toUpperCase()] = addr;
  }
  return out;
}
