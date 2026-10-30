import "./polyfill";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { ConnectionProvider, useConnection, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import App from "./App";
import { httpService, type AppDeps, type ChainApi } from "./lib/api";
import { ata, decodeMarket, decodePosition, DEFAULT_PROGRAM_ID, positionPda } from "./lib/program";

const env = import.meta.env;
const SERVICE = env.VITE_SERVICE_URL ?? "http://localhost:8787";
const ARCHIVE = env.VITE_ARCHIVE_URL ?? SERVICE;
const RPC = env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
const programId = new PublicKey(env.VITE_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
const realMarket = env.VITE_MARKET ? new PublicKey(env.VITE_MARKET) : null;
const NVDAX_MAINNET = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const service = httpService(SERVICE, ARCHIVE);

function chainApi(conn: Connection): ChainApi {
  return {
    async readMarket(m) {
      const a = await conn.getAccountInfo(m, "confirmed");
      return a && a.owner.equals(programId) ? decodeMarket(a.data) : null;
    },
    async readPosition(m, owner) {
      const a = await conn.getAccountInfo(positionPda(programId, m, owner), "confirmed");
      return a && a.owner.equals(programId) ? decodePosition(a.data) : null;
    },
    async usdcBalance(mint, owner, tokenProgram) {
      try {
        return BigInt((await conn.getTokenAccountBalance(ata(mint, owner, tokenProgram), "confirmed")).value.amount);
      } catch {
        return 0n; // no token account yet
      }
    },
    blockhash: async () => (await conn.getLatestBlockhash("confirmed")).blockhash,
    async sendRaw(raw) {
      const sig = await conn.sendRawTransaction(raw);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (r.value.err) throw new Error("Transaction failed");
      return sig;
    },
    async referencePrice() {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${NVDAX_MAINNET}`);
      const p = (await r.json())?.[NVDAX_MAINNET]?.usdPrice;
      return typeof p === "number" ? p : null;
    },
  };
}

function Connected() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const deps = useMemo<AppDeps>(() => ({
    service,
    chain: chainApi(connection),
    wallet: publicKey && signTransaction ? { publicKey, signTransaction } : null,
    programId,
    realMarket,
  }), [connection, publicKey, signTransaction]);
  return <App deps={deps} walletButton={<WalletMultiButton />} />;
}

createRoot(document.getElementById("root")!).render(
  <ConnectionProvider endpoint={RPC}>
    <WalletProvider wallets={[]} autoConnect>
      <WalletModalProvider>
        <Connected />
      </WalletModalProvider>
    </WalletProvider>
  </ConnectionProvider>,
);
