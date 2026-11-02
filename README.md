# Monday Gap Cover

Solana program (Anchor 0.30.1) plus a TypeScript test harness.

## Build and test

    npm install
    npm run build        # cargo-build-sbf -> target/deploy/gap_cover.so
    npm test             # vitest, harness in tests/harness.ts

`npm run dump:lazer` refreshes the devnet dumps in `fixtures/` (Pyth Lazer verifier
program, its storage and treasury accounts, and Token-2022).

## Harness choice: LiteSVM

The harness runs on `litesvm` 0.3.3 (the last line that takes `@solana/web3.js` v1 types).

`solana-bankrun` was tried first. It loads fine under Node 25, but it does not execute the
Ed25519 precompile: a transaction carrying an Ed25519 instruction with a garbage signature
succeeds. The Lazer verifier relies on that precompile, so under bankrun a tampered price
message would be "verified". Switching Node versions would not change this, so the harness
went straight to LiteSVM with `withSigverify(true).withPrecompiles()`, where the same forged
signature is rejected.

Other notes:

- The harness loads the devnet dump of Token-2022 (`fixtures/token2022.so`) over LiteSVM's
  bundled copy so ScaledUiAmount behaves as on the live cluster.
- The clock starts at the Pyth fixture time (29 Oct 2026). The Lazer storage account holds
  trusted signers with expiry timestamps; `warpTo` moves the clock when a test needs it.
- The treasury account is loaded with 10,000,000 lamports; the verifier charges 1 lamport.

## Build toolchain pins

Anchor 0.30.1 with the Solana platform tools (cargo 1.84) needs some lockfile pins:

- `rust-version = "1.84"` in `programs/gap_cover/Cargo.toml`, and the lockfile was generated
  with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`.
- `blake3` pinned to 1.5.5 (newer pulls `digest` 0.11, which needs edition 2024).
- `proc-macro2` pinned to 1.0.94.

`anchor build` compiles the program but its IDL step fails on current host toolchains
(anchor-syn 0.30.1 and proc-macro2 / ark-ff-macros incompatibilities). The IDL is therefore
kept by hand in `idl/gap_cover.json`; update it whenever an instruction changes.

## Multi-market

One program, one dealer service and one app cover several stocks. Each market names its Pyth Pro feed at creation:

- `create_market` takes `feed_id` (non-zero) and `exponent` (must be -5, the exponent of every
  `Equity.US.<SYM>/USD` feed) in `MarketParams`, next to the per-leg confidence caps (1..100 bps) and the
  publisher minimum (1..64). Band (100/500 bps), bounty, windows and everything else are unchanged.
- The market address is the PDA `["market", dealer, feed_id u32 LE, friday_target_ts i64 LE]`, so NVDA, TSLA, SPY
  and AAPL markets can share one weekend. A report for one feed is rejected (`WrongFeed`) on another feed's market.
- Only `create_market` derives the market address. Claims, refunds and the rest act on the market account they are
  given, so markets created by the single-feed build still settle and pay out after the upgrade.

Stocks are listed in `service/src/config.ts` (`MARKETS`): symbol, feed id, mainnet xStocks mint (Jupiter
reference), gap history file, per-leg caps and minimum publishers. NVDA, TSLA, SPY and AAPL are enabled; GOOGL, MSFT,
META, QQQ and AMZN are listed and off. `ENABLED_SYMBOLS` overrides the flags. Feed ids: NVDA 1314, TSLA 1435, SPY
1398, AAPL 922, GOOGL 1163, MSFT 1292, META 1272, QQQ 1363, AMZN 954.

The caps in `MARKETS` are provisional: plan Task 0 step 5 applied to the logger rows available on 3 Nov 2026
(cap = max(provisional, ceil(1.5 * p95 of daily p95)), provisionals Friday 10 and Monday 20 bps). TSLA gets 16/67
because its Monday-mark p95 was 44 bps; the others keep 10/20 among the enabled four. Recompute from
`data/marks.csv` after five weekdays. Caps are fixed per market at creation, so a change applies to markets created
afterwards.

The service streams every enabled feed plus every `REAL_MARKETS` market's feed (read from chain), one Pyth
subscription per feed on each socket, so every signed message carries one feed and a submit_report transaction stays
about 591 bytes however many stocks are enabled. It refuses to start when a real market's feed is not in `MARKETS`.
The archive and keeper serve a market only its own feed. The freeze rule,
the Jupiter reference and f_x are per stock. The app shows a stock picker and names the chosen stock throughout.

## Dealer service

`service/src/server.ts` serves quotes, sandbox markets, the sandbox fee-payer relay and the devnet faucet:
`GET /quote?market&buyer&contracts`, `GET /markets`, `POST /sandbox/start {mode, symbol}`, `POST /sandbox/bell {market}`,
`GET /relay`, `POST /relay {transaction}`, `POST /faucet {wallet, symbol}`. `symbol` defaults to NVDA; the faucet sends
demo USDC and that stock's test token. Keys load from file paths in `DEALER_KEYPAIR`,
`DEMO_AUTHORITY_KEYPAIR`, `RELAY_KEYPAIR` (a separate key holding only SOL for fees) and optionally `QUOTE_KEYPAIR`.
They are never logged or returned.

The program enforces the dealer's signature on a quote, not the pricing model. Every quote response carries the
formula inputs (the stock token's reference, Friday reference, `m`, base, uncertainty, utilisation, reserve) so the app can
show them.

**Historical gaps.** `service/data/<sym>-gaps.csv` holds the last 104 weekends per stock (NVDA, TSLA, SPY, AAPL now),
built by `node scripts/build-gaps.mjs NVDA TSLA SPY AAPL` from free daily bars. A stock with no gaps file is not
priced. They are a proxy: Friday regular close to Monday regular open,
not the 15:59:30 ET Friday and 09:31:30 ET Monday marks the program settles on.

**Relay rules.** The relay co-signs only a legacy transaction with at most 3 instructions whose fee payer is the
relay key and which contains exactly one `gap_cover` instruction: `buy` (index 1, with its inline Ed25519 quote at
index 0), `claim` or `refund`, on a sandbox market. The only other instruction allowed is one
`SetComputeUnitLimit` of at most 400_000. The relay key may not appear in any instruction, and the only signers are
the relay key and the user.
The relay also limits requests per IP (20 a minute) and per wallet (10 a minute) and stops co-signing when the relay
key holds less than 0.05 SOL. The faucet allows one drip per wallet every 10 minutes (kept in `logs/faucet-cooldown.json` across restarts) and
10 drips a minute overall. Its SOL comes from a separate `FAUCET_KEYPAIR`, never the dealer key that pays the
keeper's fees, and only to a wallet holding under 0.003 SOL, at most 0.25 SOL an hour in all. Without that key the
faucet sends tokens only.
The service only treats an account as a market when the gap_cover program owns it.

**Sandbox multiplier-void demo.** In this mode the service changes the test mint's multiplier when the judge rings
the Monday bell, after buying has closed, rather than right after the first sale. It then submits a Monday price
equal to the Friday price, and `finalise_monday` voids the market so buyers can claim refunds.
The Monday bell acts only on sandbox markets this service started (kept in `logs/sandbox-markets.json`, path set by
`SANDBOX_MARKETS_PATH`). Multiplier-void mode only ever changes a fresh mint the service made for that
sandbox market, never a mint read from an account. Test mints per stock are in `config/devnet.json` under
`testMints` (made by `scripts/create-test-mints.ts`); NVDA falls back to the older `nvdaxTest` entry.

**Trust: the dealer can force a void on devnet.** The program checks signatures, windows and eligibility; it does
not check that the dealer behaves fairly. On devnet each stock's mint is a test mint, and the dealer key holds its
multiplier authority. A real market voids at `finalise_monday` if the mint's multiplier differs from the one at
creation. So the dealer could watch the Monday price, and if the market would pay out, change the multiplier before
anyone calls `finalise_monday`. The market then voids: buyers get their premiums back as refunds, not payouts. Funds
are never lost, but the cover is only as good as the dealer's restraint. The mainnet design uses the real xStocks
tokens, whose multiplier is set by its issuer and not by the dealer, so the dealer would hold no such option there.

**Deployment behind a proxy.** Per-IP limits use the socket address by default. Set `TRUST_PROXY=1` only when the
service sits behind a reverse proxy you control. The limits then use the first `X-Forwarded-For` hop, which a client
can forge when no proxy is in front.

See `docs/deploy-service.md` for the image, required settings, the volume for `logs/` and the multi-market deploy
order.

## App settings

`VITE_SYMBOLS` (comma list, default `NVDA,TSLA,SPY,AAPL`) sets the stocks in the picker. `VITE_MARKETS` maps each
stock to this weekend's real market, for example `NVDA=<address>,TSLA=<address>`; a stock with none shows "No <SYM>
market this weekend". The older `VITE_MARKET` still works and means NVDA. Also `VITE_SERVICE_URL`,
`VITE_ARCHIVE_URL`, `VITE_RPC_URL`, `VITE_PROGRAM_ID`.
