# Monday Gap Cover: design spec

Status: draft for review, 30 October 2026
Target: Solana Foundation "Perps and Prediction Markets" hackathon, submissions close 5 December 2026

## 1. Product

An NVDAx holder keeps their shares over the weekend and buys a fully collateralised USDC payout that grows if NVDA is lower on Monday morning than on Friday afternoon.

Each contract pays nothing if NVDA falls 1% or less between the two marks, then rises linearly to $1.00 at a fall of 5% or more. A holder covers the 1% to 5% band with one contract per $25 of NVDAx: 200 contracts for a $5,000 position, paying $50 at a 2% fall and $200 at 5% or worse.

Financially this is a cash-settled put spread on one weekend. The pitch says so. The difference from Roster's Floor puts is stated as: "Roster sells exercisable, stock-settled Floors; Monday Gap Cover is a cash-settled, one-weekend loss-band reimbursement sized to xStocks you already hold, without moving or exercising those shares."

The app is built for NVDAx holders: the calculator sizes cover from the wallet's NVDAx balance or a sample portfolio. Anyone can buy, as with any put. The pitch never says "holders only", "liquidation insurance" or "the open".

Kamino borrowers are a secondary use case, described as cash to rebuild collateral after Monday morning, not protection from liquidation at 09:30.

## 2. Names used everywhere

| Term | Meaning |
|---|---|
| Friday afternoon mark | Verified NVDA regular-session price closest to 15:59:30 ET Friday (12:59:30 ET on early-close Fridays) |
| Monday morning mark | Verified NVDA regular-session price closest to 09:31:30 ET Monday |
| Gap | (Friday mark - Monday mark) / Friday mark, positive when NVDA fell |
| Dealer | One bot-owned account that sells cover and posts all collateral |

The word "open" appears in no user-facing text: app, calculator, README, pitch, video or submission.

## 3. Scope

In: one market per weekend on NVDA; buy, settle, claim, void; a sandbox mode for judges; a history page.

Out, in writing: other stocks, selling cover back, transferable positions, public liquidity deposits, Kamino integration, implied volatility, a secondary market, mainnet real-money trading.

## 4. Lifecycle

1. **Create.** Before Friday's mark, the dealer creates the market with immutable parameters (section 6) and funds a settlement-bounty reserve. Creation is refused if Friday or Monday is a market holiday per Pyth's schedule for feed 1314. On early-close Fridays the Friday target moves to 12:59:30 ET.
2. **Friday mark.** Settled by the same rules as Monday (section 5). Buying cannot open until the Friday mark is final.
3. **Buying.** From Friday mark finalisation until Sunday 17:50 ET. Each buy needs a dealer-signed quote (section 7).
4. **Locked.** From Sunday 17:50 ET to the Monday mark, no buying. The app shows a "locked, tracking live" view: estimated payout from the live NVDAx price, labelled as an estimate.
5. **Monday mark.** Settled per section 5.
6. **Claim.** After finalisation, each buyer claims their payout. Claims close 30 days after finalisation, after which anyone may sweep remaining funds to the dealer.
7. **Void.** Any void condition (section 8) refunds every buyer's full premium and returns the dealer's collateral.

## 5. Settlement rules

Applies to both marks. For target time T:

- An eligible report is a Pyth Pro update for feed 1314 that passes Pyth's Lazer verifier (`pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`, Ed25519 instruction at index 0) and in which:
  - `marketSession == regular`
  - `feedUpdateTimestamp == timestampUs` exactly
  - `feedUpdateTimestamp` is within T ± 5 seconds
  - `confidence / price <= conf_cap_bps` (provisionally 25 bps; see section 13)
  - `publisherCount >= min_publishers` (provisionally 10)
- Anyone may submit an eligible report from T until T + 7 minutes. The first submission becomes the candidate.
- A later eligible report replaces the candidate if it ranks lower on `(|feedUpdateTimestamp - T|, feedUpdateTimestamp, sha256(payload))`. The ordering is total, so the result does not depend on submission order.
- At or after T + 7 minutes, anyone may call finalise. With a candidate, the mark is fixed. Without one, the market voids.
- The account whose report is final receives the settlement bounty from the bounty reserve, never from buyer escrow.
- The verifier checks signatures only; the spike showed it accepts a 45-minute-old payload. Every check above runs in this program.
- The dealer's keeper archives every signed update it receives in T ± 5 seconds and publishes them at a public URL, so anyone can submit a closer report without a Pyth Pro key.

## 6. Market parameters

Fixed at creation, never changeable:

- feed id (1314), NVDAx mint, USDC mint
- Friday and Monday target times (UTC)
- band lower and upper (100 and 500 bps)
- conf_cap_bps, min_publishers, eligibility window (5 s), challenge period (7 min)
- maximum contracts, buying close time
- sandbox flag
- NVDAx effective scaled-UI multiplier at creation

After the first sale, the dealer can stop issuing quotes and nothing else.

## 7. Pricing and quotes

The dealer prices off-chain and signs a quote per buy:

`premium per contract = base expected payout + model-uncertainty loading + utilisation loading + settlement reserve`

- Base expected payout comes from NVDA's historical Friday-afternoon-to-Monday-morning gap distribution, recomputed weekly.
- Utilisation loading rises as contracts sold approach the maximum, using the inventory-skew curve from the Avellaneda-Stoikov simulator. It is presented as a utilisation curve, not as market making.
- The weekend NVDAx price adjusts the base: quotes reprice when NVDAx moves 0.5% or every 15 minutes. If NVDAx moves more than 5% within 30 minutes, or its reference pool's liquidity falls below a threshold, the dealer stops quoting until it recovers.
- The quote is signed with the dealer's Ed25519 key and binds: market, buyer, contract count, total premium, expiry (15 seconds), nonce.
- The program rejects a buy if the quote is expired, the nonce was used, the buyer differs, buying is closed, or capacity is exceeded.
- The formula and its inputs are shown in the app for every quote.

## 8. Void conditions

All objective, none chosen by the dealer:

- no eligible report for a mark by T + 7 minutes
- NVDAx's effective scaled-UI multiplier at Monday's target differs from the one recorded at creation, or a change is scheduled at or before Monday's target. The effective multiplier at time t is `new_multiplier` if `t >= new_multiplier_effective_timestamp`, otherwise `multiplier`; the program never treats a past effective timestamp as pending.

## 9. Money

All amounts in USDC base units (6 decimals), integer arithmetic only.

- On buy: buyer pays the premium into the market escrow; the dealer tops up to exactly $1.00 per contract. Invariant: `escrow == contracts_sold * 1_000_000` until finalisation.
- On finalisation: `gap_bps = (friday - monday) * 10_000 / friday` (computed in a wide integer type with both prices at the same exponent). `payout = clamp((gap_bps - 100) * 1_000_000 / 400, 0, 1_000_000)` per contract, rounded down. Premiums move to the dealer; unpaid collateral returns to the dealer.
- On void: every buyer gets their premium back; the dealer gets its collateral back.
- The bounty reserve is a separate account funded by the dealer at creation.

## 10. Accounts and instructions

Accounts: `Market` (parameters, state, candidate report, counters), `Escrow` (USDC token account owned by the market PDA), `BountyReserve`, `Position` PDA seeded by [market, buyer] (contracts, premium paid, claimed flag). No position token is minted, so positions cannot be transferred.

Instructions: `create_market`, `submit_report` (Friday or Monday), `finalise`, `buy` (with signed quote), `claim`, `refund` (after void), `sweep` (after the claim deadline).

Sandbox markets (flag set at creation) accept prices signed by a demo authority instead of Pyth, run on 5-minute timelines, and are labelled "Sandbox" on every screen. Real markets never accept the demo authority.

## 11. Off-chain parts

- Keeper: connects to all three Pyth Pro endpoints, archives updates around each target, submits and challenges reports, calls finalise.
- Quote server: computes and signs quotes; holds the Pyth key and dealer key server-side only.
- Fee payer: pays transaction fees so judges need no devnet SOL for any step.
- Frontend: calculator, buy flow, locked view, settlement proof screen (signed price, session, timestamp, publishers, confidence, escrow before and after), history page.

## 12. Demo

- Devnet only, with demo USDC and a Token-2022 test mint "NVDAx (test)" carrying the scaled-UI extension. Judges get both from a faucet button.
- Sandbox: each judge starts a fresh sandbox weekend, picks a Monday gap (for example 0.5%, 2.5%, 6%) or a multiplier-change void, and runs buy to claim in under a minute.
- Real: at least one real weekend settled on devnet with Pyth Pro data before submission, with transaction links in the README.
- History page (spare day): the last 12 to 20 NVDA weekends with the gap, what 200 contracts paid, the premium the model would have charged, and the dealer's profit or loss. If a past weekend can be settled through the real Pyth path, show that too.
- Failure demo: an old signed payload rejected, then a fresh regular-session payload accepted.

## 13. Open items

1. Measure confidence and publisher count at 09:31:30 and 15:59:30 on several weekdays before fixing `conf_cap_bps` and `min_publishers`. The spike measured only the first minute after 09:30 (p95 13.6 bps, 20 publishers).
2. Choose the NVDAx reference pool and liquidity threshold for the quoting freeze.
3. Name the real weekend to settle before submission.
4. Confirm the build-week dates when the hackathon page publishes them.

## 14. Tests

- payout clamp at 0.5%, 1%, 2%, 5%, 10% gaps, and rounding never exceeding escrow
- report eligibility: wrong feed, wrong session, stale timestamp, outside window, wide confidence, too few publishers, tampered signature
- replacement ordering and ties
- finalise with and without a candidate
- multiplier change and scheduled change void; past effective timestamp not treated as pending
- holiday refusal and early-close Friday target
- void refunds premiums and collateral in full
- quote expiry, nonce reuse, wrong buyer, capacity, buying after close
- no instruction exists to transfer a position
