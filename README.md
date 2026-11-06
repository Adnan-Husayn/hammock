# Hammock

Weekend gap cover for tokenised stocks on Solana.

**Live app (devnet):** https://hammock-finance.vercel.app

The US stock market closes at 16:00 ET on Friday and opens at 09:30 ET on Monday. Tokenised stocks such as NVDAx keep trading all weekend, but the price that matters for a holder is where the real stock opens on Monday. Hammock lets a holder buy cover before the weekend. If the stock opens Monday more than 1% below Friday's close, Hammock pays out in USDC.

Built for the Solana Foundation Perps and Prediction Markets hackathon. Runs on devnet with demo USDC and test tokens.

## How the cover works

Each contract pays from $0 to $1, set by how far the stock falls between two signed Pyth prices: the Friday close mark and the Monday open mark.

    payout per contract = clamp((fall - 1%) / 4%, 0, 1)

- A fall of 1% or less pays nothing.
- Between 1% and 5% the payout rises in a straight line.
- At 5% and beyond it pays the full $1.

Buy one contract for every $25 of the token you hold and your net loss stays flat across the whole 1% to 5% range. Drawn on a chart, that flat stretch between two posts looks like a hammock, which is where the name comes from.

Example: $5,000 of NVDAx, 200 contracts, $23.91 premium.

| Monday fall | Loss without cover | Payout | Net loss with cover |
|---|---|---|---|
| 0% | $0.00 | $0.00 | -$23.91 |
| 1% | -$50.00 | $0.00 | -$73.91 |
| 3% | -$150.00 | +$100.00 | -$73.91 |
| 5% | -$250.00 | +$200.00 | -$73.91 |
| 8% | -$400.00 | +$200.00 | -$223.91 |

More than one contract per $25 makes the line tilt upward through the band. That turns cover into a bet on the fall, and the app says so.

## Settlement

Prices come from Pyth Pro (Lazer) signed reports. The program verifies each report on chain through the Pyth Lazer verifier and the Ed25519 precompile, and it only accepts a report that is:

- for the market's own feed (NVDA is feed 1314),
- close to the target time (Friday 15:59:30 ET, Monday 09:31:30 ET),
- under the market's confidence cap and above its minimum publisher count.

Anyone can submit a report and earn a small bounty. A closer report replaces a farther one. If no valid Monday report arrives, or the token's share multiplier changes over the weekend, the market voids and buyers can take their premium back.

## What is in the repo

| Path | What it is |
|---|---|
| `programs/gap_cover` | Anchor program: create market, buy with a dealer-signed quote, record the Friday and Monday marks, claim, refund, void |
| `service` | Dealer service: quotes, a keeper that submits Pyth reports, a fee-payer relay for the sandbox, a devnet faucet |
| `app` | React app: stock picker, demo weekend, cover card with the payoff chart, claim, receipts, history |
| `tests` | Program tests on LiteSVM with real Pyth fixtures and signature checks switched on |
| `scripts` | Market creation, test mints, devnet deploy, and a logger that records real Pyth marks every weekday |
| `docs` | Design notes, deploy guide and [development notes](docs/development.md) |

Program id on devnet: `HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g`

Stocks: NVDA, TSLA, SPY and AAPL are on. GOOGL, MSFT, META, QQQ and AMZN are configured and off until their price data checks out.

## Try it

The app runs a full demo weekend without a wallet: buy cover, watch the Friday and Monday marks land, then claim. Demo results are labelled as demo and never shown as signed prices. With a devnet wallet, the sandbox runs a real market end to end, with fees paid by the relay.

## Run it locally

Program and tests:

    npm install
    npm run build      # cargo-build-sbf, output in target/deploy/gap_cover.so
    npm test

App:

    cd app
    npm install
    npm run dev

Service:

    cd service
    npm install
    npm test

The service needs keypair files and settings described in [docs/deploy-service.md](docs/deploy-service.md). Toolchain pins, the reason for LiteSVM over bankrun, and the full service reference are in [docs/development.md](docs/development.md).

## Limits

- Devnet only. All money is demo USDC.
- On devnet the dealer controls the test token's multiplier, so it could force a void. Buyers would get refunds, not payouts. With the real xStocks tokens the issuer sets the multiplier, not the dealer.
- Pricing uses two years of weekend gaps per stock as a proxy. The program checks the dealer's signature on a quote, not the pricing model.

## Author

Built by Adnan Husayn. [github.com/Adnan-Husayn](https://github.com/Adnan-Husayn)
