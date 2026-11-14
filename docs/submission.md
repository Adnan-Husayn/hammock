# Hammock submission text

Solana Foundation Perps and Prediction Markets hackathon. Deadline 5 December 2026. Solo build by Adnan Husayn.

Live app (devnet): https://hammock-finance.vercel.app
Program id (devnet): `HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g`

## Tagline

Buy before the weekend. If the stock gaps down Monday, Hammock pays you in USDC.

## Short description

Hammock is weekend gap cover for tokenised stocks on Solana. Buy before the weekend. If the stock gaps down Monday, Hammock pays you in USDC, up to $1 per contract. Two signed Pyth prices, verified on chain, decide the payout. On devnet for NVDA, TSLA, SPY and AAPL.

## Full description

### The problem

The US stock market closes at 16:00 ET on Friday and starts again at 09:30 ET on Monday. That is 65 hours and 30 minutes with no trading in the real stock. Tokenised stocks such as NVDAx keep trading on Solana the whole time, but the price that decides what a holder owns on Monday is the price of the real stock when the market comes back.

A holder who wants to keep their shares over the weekend has two choices today. They can sell on Friday and buy back on Monday, or they can hold and take whatever the gap turns out to be. I wanted a third choice that costs a small, known amount and leaves the shares where they are.

### Who it is for

I built Hammock for people who hold xStocks tokens (NVDAx, TSLAx, SPYx, AAPLx) and plan to keep holding them. A second use is a borrower who has posted a tokenised stock as collateral and wants cash on Monday morning to rebuild that collateral after a gap. Hammock pays cash after the Monday mark. It does not stop a liquidation.

Anyone can buy. The program does not check holdings, because a wallet snapshot cannot see tokens sitting in a lending market or a pool. The app sizes cover from the holding you enter and warns you when you buy more than the holding needs, because past that point the cover is a bet on the fall.

### How the cover pays

Each contract pays between 0 and 1 USDC. The amount depends on the gap, which is how far the stock fell between the Friday afternoon mark and the Monday morning mark.

    payout per contract = clamp((gap - 1%) / 4%, 0, 1) USDC

A fall of 1% or less pays nothing. Between 1% and 5% the payout rises in a straight line. At 5% and beyond it pays the full 1 USDC. A rise pays nothing.

One contract for every $25 of the token keeps the holder's net loss flat across the whole 1% to 5% range. On a chart that flat stretch hangs between two posts, at 1% and at 5%, and that shape gave the product its name.

Financially this is a cash-settled put spread on one weekend. The holder never moves or exercises their shares.

### A worked example with real prices

On the weekend of 6 to 9 November 2026 I ran a practice NVDA market on devnet. The program recorded these two marks.

| | Price | Time (ET) |
|---|---|---|
| Friday afternoon mark, 6 Nov | $186.90 | 15:59:30 |
| Monday morning mark, 9 Nov | $172.38 | 09:31:30 |

The gap was 7.77% down. The formula gives clamp((7.77% - 1%) / 4%, 0, 1) = clamp(1.69, 0, 1) = 1.00 USDC per contract, the full payout. The program stored that figure on chain.

Nobody bought cover in that market, so no claim was paid. The arithmetic for a holder with $5,000 of NVDAx and 200 contracts would have been:

| | Amount |
|---|---|
| Loss on the stock, 7.77% of $5,000 | about -$388 |
| Payout, 200 x 1.00 USDC | +$200.00 |
| Premium, at the app's sample rate of $0.11955 per contract | -$23.91 |
| Net loss with cover | about -$212 |

The premium in that table is the sample rate the app shows, because the market sold no contracts and so no quote from that weekend was ever paid. The cap shows up in the result. Cover absorbed the 1% to 5% band, and the holder carried the first 1% and everything past 5%.

### How settlement works

Both marks are Pyth Pro (Lazer) signed price reports for the stock's own feed. The Friday afternoon mark is the eligible report closest in time to 15:59:30 ET on Friday, or 12:59:30 ET on an early-close Friday. The Monday morning mark is the eligible report closest in time to 09:31:30 ET on Monday.

The program checks every report on chain before it counts.

- It calls Pyth's Lazer verifier (`pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`) to check the signature, and it checks that the bytes it parses are the same bytes that were signed.
- The report must be for the market's feed (NVDA is feed 1314) and from the regular trading session.
- The report's timestamp must sit within 5 seconds of the target time.
- The confidence interval must be under the market's cap for that leg, and the publisher count must meet the market's minimum. For NVDA the caps are 19 bps on Friday and 61 bps on Monday, with at least 10 publishers.

Anyone can submit a report for 7 minutes after the target time. A report replaces the current one only when it is closer in time to the target. After the 7 minutes anyone can finalise the mark, and the submitter of the winning report earns a 0.10 USDC bounty.

### Why it is hard to game

The marks come from the regular session of the real stock, so the thin weekend market for the token has no say in the payout. A whale who pushes NVDAx around on Saturday night changes nothing.

Nobody picks the price. "Closest" means closest in time and never in price, the window is 10 seconds wide, and anyone holding a closer signed report can replace the current one. The Pyth verifier on its own accepts old reports (in my test it accepted one 45 minutes old), so my program does the time, session, feed, confidence and publisher checks itself. Tests cover a 45-minute-old report and a tampered signature, and the program rejects both.

The dealer cannot change a market after creating it. Feed, target times, band, caps, bounty, contract limit and the quote-signing key are fixed at creation. After the first sale the dealer can stop issuing quotes and nothing else.

Every contract is fully collateralised before it is sold. The dealer deposits 1 USDC per contract of capacity when it creates the market, and the practice market held 1,000.20 demo USDC for 1,000 contracts and two bounties.

A buyer cannot be charged a price they did not see. The buy instruction takes no amounts. Contracts and premium come only from a dealer-signed quote that names the buyer, expires within 90 seconds and carries a nonce.

If no valid Monday report arrives, or the token's share multiplier changes over the weekend, the market voids and every buyer can take their premium back. Refunds after a void never expire.

### On chain and off chain

On chain, in one Anchor program:

- market creation with fixed parameters and prefunded reserves
- buying with a dealer-signed quote
- report submission with the checks above, and both finalisations
- the gap and payout calculation
- escrow, claim, refund, and a sweep of unclaimed payouts 30 days after settlement

Off chain, in one dealer service:

- pricing, from the last 104 weekend gaps of each stock plus a margin and a utilisation charge
- quote signing, and a freeze on quotes when the token price moves more than 5% in 30 minutes
- a keeper that streams Pyth Pro, submits reports and calls finalise
- a public archive of every signed report received within 5 seconds of each target, so anyone can submit a closer one without their own Pyth Pro key
- for the sandbox only, a faucet, a fee-payer relay and a demo price authority

The program enforces the dealer's signature on a quote. It does not judge whether the premium is fair, and the app shows the premium before you confirm.

### What I proved on devnet

- A practice NVDA market settled with nobody at the keyboard. The keeper submitted both marks and finalised at 14:38:32 UTC on 9 November, 7 minutes after the Monday target of 14:31:30 UTC. Market account: `4hq55H24V9VPGsXZs8cyp4jCF69g2SKTaNNw45Dx7kug`.
- Both marks landed on their target second, at $186.90 and $172.38, and the program recorded the full 1.00 USDC payout per contract for the 7.77% gap.
- The sandbox runs the whole user flow against the deployed program: faucet, buy, Monday mark, claim, and a void with a refund. On 14 November an end-to-end script ran buy, Monday mark and claim on the hosted service for each of NVDA, TSLA, SPY and AAPL. Each run bought 200 contracts, drew a 1.5% sandbox fall and paid a 25 USDC claim. Those are sandbox prices set by the demo authority and not Pyth marks.
- The multi-stock program is upgraded on devnet and the hosted service lists four stocks: NVDA, TSLA, SPY and AAPL. Each has its own Pyth feed, confidence caps from five weekdays of logged marks, and its own test token.

A real market with a real buy and a real claim is the piece still missing, and it is scheduled.

- [FILL AFTER 30 NOV: weekend of 27 to 30 Nov. Which of NVDA, TSLA, SPY, AAPL had markets, and each market address]
- [FILL AFTER 30 NOV: Friday afternoon mark at 12:59:30 ET on 27 Nov (early close) and Monday morning mark at 09:31:30 ET on 30 Nov, per stock]
- [FILL AFTER 30 NOV: gap per stock and payout per contract]
- [FILL AFTER 30 NOV: contracts bought, premium paid, amount claimed, and Explorer links for the buy and the claim transactions]
- [FILL AFTER 30 NOV: how long after the Monday mark the market finalised, and whether anyone touched it by hand]

### Honest limits

- Devnet only. All money is demo USDC and the stock tokens are test tokens.
- No claim has been paid on a market settled by Pyth marks yet. The 9 November market sold 0 contracts, and the claims paid so far are on sandbox markets.
- One dealer sells all the cover and posts all the collateral. There are no public liquidity deposits, and you cannot sell cover back or transfer a position.
- On devnet the dealer controls the test token's multiplier, so it could force a void. Buyers would get refunds in place of payouts. With the real xStocks tokens the issuer sets the multiplier.
- Nothing on chain ties a market's stock token to its price feed. The dealer is trusted to pass the right token when it creates the market.
- The program cannot prove the public archive is complete. The dealer could withhold a report. Anyone with their own Pyth Pro access can still submit one.
- Pricing uses two years of weekend gaps per stock. The coefficients are provisional.
- Cover stops at 5%. Past that the holder's loss grows again, as the 9 November example shows.

### What is next

- Run the 27 to 30 November weekend with a real buy and claim, then put the transaction links in this file and the README.
- Turn on GOOGL, MSFT, META, QQQ and AMZN once their price data checks out. They are configured and switched off.
- Tie each market's stock token to its feed on chain.
- Recompute the confidence caps as more weekdays of logged marks come in.

## How to try it

Everything below is on Solana devnet with demo tokens. You pay nothing.

### Without a wallet

1. Go to https://hammock-finance.vercel.app. The first screen says "You hold $5,000 of NVDAx."
2. Drag the dot along the payoff line on the cover card. Net loss stays at $73.91 between a 1% and a 5% fall.
3. Press "Run a demo weekend". Choose the stock and holding, go to the review step, and press "Confirm demo cover".
4. The card says "Cover active". The demo clock runs the weekend in about 4 seconds, or you can press "Go to the Monday mark".
5. The demo marks are $180.00 and $174.60, a 3% fall. Press "Claim $100.00 USDC".
6. Try the four replay pills under the status line: No payout, Partial fall, Cap and Void.

Demo runs use made-up prices and the app labels them "Demo prices, not Pyth, not a settlement".

### With a devnet wallet, on the real program

[FILL: the web app has not been republished since the multi-stock upgrade. Republish it, confirm the stock picker shows NVDA, TSLA, SPY and AAPL and that this flow passes on the live site, then delete this note. Until then the steps below are checked for NVDA only.]

1. Set a Solana wallet to devnet and connect it. You do not need any SOL or tokens.
2. In "How cover works", press "Show details".
3. Press "Run an NVDA weekend on devnet". Hammock sends demo USDC and test NVDAx to your wallet and creates a fresh sandbox market with a Friday mark.
4. Press "Buy cover" and sign once. That buys 200 contracts. The relay pays the fee.
5. The Monday mark lands by itself. The fall is picked at random from 1.5%, 2.5%, 4% and 6% after buying closes, so you cannot buy knowing the result. Those falls pay $25, $75, $150 and $200 on 200 contracts.
6. Press "Claim" and sign once. The USDC arrives in your wallet.
7. Press "See the proof" for the settlement receipt: both marks, the measured fall, the payout arithmetic, the escrow account and the USDC transfer, with links to Solana Explorer.
8. To see a void and a refund, press "Open the step-by-step sandbox" and choose "Start in multiplier-void mode".

Sandbox markets use prices set by a demo authority and the app labels them "Sandbox prices, not Pyth". Real markets never accept the demo authority.

### The verified market

[FILL: confirm the deployed app shows the 9 Nov practice market under "Replay a weekend", "Verified replay". It needs VITE_VERIFIED_MARKET set to `4hq55H24V9VPGsXZs8cyp4jCF69g2SKTaNNw45Dx7kug` at build time. If it is set, add the step here.]

You can read the practice market account on Solana Explorer at any time:
https://explorer.solana.com/address/4hq55H24V9VPGsXZs8cyp4jCF69g2SKTaNNw45Dx7kug?cluster=devnet

## Tech

- Solana devnet, one Anchor program in Rust (`programs/gap_cover`): create market, submit report, finalise Friday, finalise Monday, buy, claim, refund, sweep, close
- Pyth Pro (Lazer) signed reports, verified on chain by CPI to Pyth's Lazer verifier plus the Ed25519 precompile
- Token-2022 test tokens with the scaled UI amount extension, to match how xStocks handle share multipliers
- Dealer service in TypeScript on Fly.io: quote signer, keeper, public report archive, sandbox faucet and fee-payer relay
- Jupiter quotes for the weekend token reference price
- React and Vite app on Vercel, with Solana wallet adapter
- Program tests on LiteSVM with real Pyth fixtures and signature checks switched on; Vitest for the service and app
- A logger that records real Pyth marks for nine stocks every weekday, used to set the confidence caps

Repo: [FILL: public repository URL for monday-gap-cover]
Demo video: [FILL: video URL]
