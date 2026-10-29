# Monday Gap Cover: design spec

Status: version 2 for review, 30 October 2026. Revised after reviews by Muse and GPT of version 1.
Target: Solana Foundation "Perps and Prediction Markets" hackathon, submissions close Saturday 5 December 2026

## 1. Product

An NVDAx holder keeps their shares over the weekend and buys a fully collateralised USDC payout that grows if NVDA is lower on Monday morning than on Friday afternoon.

Each contract pays nothing if NVDA falls 1% or less between the two marks, then rises linearly to $1.00 at a fall of 5% or more. A holder covers the 1% to 5% band with one contract per $25 of NVDAx: 200 contracts for a $5,000 position, paying $50 at a 2% fall and $200 at 5% or worse. The calculator always shows net loss after payout and premium, not just the payout.

Financially this is a cash-settled put spread on one weekend, and the pitch says so. Difference from Roster's Floor puts: "Roster sells exercisable, stock-settled Floors; Monday Gap Cover is a cash-settled, one-weekend loss-band reimbursement sized to xStocks you already hold, without moving or exercising those shares."

**Anyone can buy, deliberately.** The app is built for NVDAx holders through its calculator, which sizes cover from the wallet's NVDAx balance or a sample portfolio, but the program does not check holdings. A Friday wallet snapshot was rejected for two reasons: it cannot see NVDAx deposited in Kamino, liquidity pools or exchanges, which excludes the holders with most reason to buy, and it costs two to three days of a one-week build. The dealer's exposure to informed weekend buyers is bounded instead by the hard contract cap, signed short-lived quotes, repricing from the live NVDAx price, and the quoting freeze (section 7). The pitch says "built for NVDAx holders" and never "holders only", "liquidation insurance" or "the open".

Kamino borrowers are a secondary use case, described as cash to rebuild collateral after Monday morning, not protection from liquidation at 09:30.

## 2. Names used everywhere

| Term | Meaning |
|---|---|
| Friday afternoon mark | The eligible NVDA report whose timestamp is closest to 15:59:30 ET Friday (12:59:30 ET on early-close Fridays) |
| Monday morning mark | The eligible NVDA report whose timestamp is closest to 09:31:30 ET Monday |
| Gap | (Friday mark - Monday mark) / Friday mark, positive when NVDA fell |
| Dealer | One bot-owned account that sells cover and posts all collateral |
| Dealer service | One server running the keeper, the quote signer and the sandbox demo authority |

"Closest" always means closest in time, never in price. The word "open" appears in no user-facing text.

## 3. Scope

In: one market per weekend on NVDA; buy, settle, claim, refund, sweep, close; a sandbox mode for judges; a one-table backtest in the README.

Out, in writing: other stocks, selling cover back, transferable positions, public liquidity deposits, Kamino integration, implied volatility, a secondary market, mainnet real-money trading, a history page.

## 4. Lifecycle

1. **Create.** At least one hour before the Friday target, the dealer creates the market with immutable parameters (section 6) and pre-funds the `CollateralReserve` with `max_contracts × 1 USDC` and the `BountyReserve` with two bounties. The dealer service refuses to create a market if Pyth's schedule for feed 1314 shows Friday or Monday as a holiday, and moves the Friday target to 12:59:30 ET on early-close Fridays. The program cannot read that schedule; it enforces only the UTC targets fixed at creation.
2. **Friday mark.** Settled by section 5. Buying cannot open until it is final.
3. **Buying.** From Friday mark finalisation until Sunday 17:50 ET, using dealer-signed quotes (section 7).
4. **Locked.** Sunday 17:50 ET to the Monday mark. The app shows an estimated payout from the live NVDAx reference price, labelled as an estimate.
5. **Monday mark.** Settled by section 5.
6. **Claim.** After finalisation, each buyer may claim their payout into their own USDC account.
7. **Void.** Under any section 8 condition, each buyer may claim a refund of their premium, and the dealer recovers the rest.
8. **Sweep and close.** Described in section 9.

## 5. Settlement rules

Applies to both marks. For target time T:

- An eligible report is a Pyth Pro update for feed 1314 that passes Pyth's Lazer verifier (`pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`, called by CPI, with the Ed25519 instruction placed before it in the same transaction), and in which:
  - `marketSession == regular`
  - `feedUpdateTimestamp == timestampUs` exactly
  - `feedUpdateTimestamp` is within T ± 5 seconds
  - `price > 0`, and `exponent` equals the exponent recorded at creation (−5 for feed 1314); otherwise the report is rejected
  - `confidence × 10,000 / price <= conf_cap_bps` for that leg
  - `publisherCount >= min_publishers`
- Anyone may submit an eligible report during the submission window, from T until T + 7 minutes. The first becomes the candidate, and its submitter is stored.
- A later eligible report replaces the candidate if it ranks lower on `(|feedUpdateTimestamp - T|, feedUpdateTimestamp, sha256(payload))`. The order is total, so the outcome does not depend on submission order.
- At or after T + 7 minutes, anyone may call `finalise`. With a candidate, the mark is fixed and the stored submitter receives that leg's bounty from the `BountyReserve`. Without one, the market voids.
- The submitter pays the Lazer verifier's treasury fee (1 lamport) and its own transaction fee.
- The verifier checks signatures only; the spike showed it accepts a 45-minute-old payload. Every check above runs in this program.
- The dealer service publishes every signed update it receives within T ± 5 seconds to a public URL as it arrives, so anyone can submit a closer report without a Pyth Pro key. The program cannot prove that archive is complete. The README states this plainly: challenges are permissionless given the published archive, and the dealer could in principle withhold a report. Anyone with their own Pyth Pro access can still challenge.

## 6. Market parameters

Fixed at creation, never changeable:

- feed id (1314), price exponent (−5), NVDAx mint, USDC mint
- Friday and Monday target times (UTC), buying close time
- band lower and upper (100 and 500 bps)
- conf_cap_bps per leg, min_publishers, eligibility window (5 s), submission window (7 min)
- maximum contracts, bounty per leg (0.10 USDC), claim deadline (30 days after Monday finalisation)
- dealer quote-signing key, quote maximum lifetime (90 s)
- sandbox flag and, for sandbox markets, the timings in section 10
- NVDAx effective scaled-UI multiplier at creation

After the first sale, the dealer can stop issuing quotes and nothing else.

## 7. Pricing and quotes

The dealer service prices off-chain at the moment a quote is requested:

`premium per contract = base + uncertainty + utilisation + reserve`

- **Base:** expected payout per contract from the empirical distribution of NVDA Friday-afternoon-to-Monday-morning gaps over the last 104 weekends, with each historical gap shifted by the current weekend NVDAx move from Friday's mark.
- **Uncertainty:** 25% of base plus 0.005 USDC.
- **Utilisation:** `base × 2 × u²`, where u is contracts sold divided by maximum contracts. This is the inventory-skew curve from the Avellaneda-Stoikov simulator, presented as a utilisation curve.
- **Reserve:** 0.002 USDC.
- The coefficients are provisional and get checked against the backtest on build day one.
- **NVDAx reference price:** Haircut's method. The service quotes a $1,000 USDC to NVDAx round trip through Jupiter; the buy leg gives the price, the round-trip cost measures liquidity.
- **Freeze:** quoting stops if the NVDAx reference price moves more than 5% within 30 minutes, if the round-trip cost exceeds 100 bps, or if Jupiter returns no route. Quoting resumes automatically after 15 minutes with none of those true. Nobody resumes it by hand.
- **The quote:** a message signed with the dealer's Ed25519 key binding market, buyer, contract count, total premium, expiry and nonce. `0 < premium per contract < 1 USDC` is required.
- **On-chain checks in `buy`:** the program reads the Ed25519 instruction through the instructions sysvar and checks it is the dealer's key over exactly these fields; rejects if expired by the Solana clock, if `nonce != position.last_nonce + 1`, if the buyer differs, if buying is closed, or if capacity would be exceeded.
- **What the program does not check:** whether the premium is fair. It enforces the dealer's signature, not the pricing model. The app shows the formula and its inputs for every quote, and the README says so.
- The app refreshes the quote automatically before it expires, so a judge never meets an "expired quote" error.

## 8. Void conditions

All objective, none chosen by the dealer:

- no eligible report for a mark by T + 7 minutes
- NVDAx's effective scaled-UI multiplier changes at any time from market creation through the Monday target, or a change is scheduled to take effect in that period. The effective multiplier at time t is `new_multiplier` if `t >= new_multiplier_effective_timestamp`, otherwise `multiplier`. A past effective timestamp is never treated as pending.

## 9. Money

All amounts in USDC base units (6 decimals). All arithmetic is checked `i128`; any overflow or negative intermediate fails the instruction.

- **Create:** dealer deposits `max_contracts × 1_000_000` into `CollateralReserve` and `2 × bounty` into `BountyReserve`. Both are PDA-owned.
- **Buy** (signed by the buyer only): buyer pays `premium` into `Escrow`; the program moves `contracts × 1_000_000 − premium` from `CollateralReserve` into `Escrow`. Invariant until finalisation: `Escrow == contracts_sold × 1_000_000`, and `total_premiums` is tracked separately.
- **Finalise:**
  - `gap_bps = (friday − monday) × 10_000 / friday`, signed; prices share the creation-time exponent.
  - `payout_per_contract = clamp((gap_bps − 100) × 1_000_000 / 400, 0, 1_000_000)`, rounded down.
  - `Escrow` keeps `contracts_sold × payout_per_contract` for claims; the remainder and the unused `CollateralReserve` go to the dealer.
- **Void:** `Escrow` keeps `total_premiums` for refunds; the rest of `Escrow`, the unused `CollateralReserve` and the unused bounties go to the dealer.
- **Claim / refund:** paid only to the position owner's USDC account.
- **Sweep, after a finalised market:** after the claim deadline, anyone may sweep unclaimed payouts to the dealer.
- **After a void:** refunds never expire and are never swept. Buyers' premiums stay claimable.
- **Close:** a market voided before any sale, or fully claimed, can be closed by anyone and its rent returned to the dealer.

## 10. Accounts, instructions and signers

Accounts: `Market` (parameters, state, candidate report and submitter, counters, total premiums), `Escrow`, `CollateralReserve` and `BountyReserve` (USDC accounts owned by the market PDA), `Position` PDA seeded by [market, buyer] (contracts, premium paid, last nonce, claimed flag). No position token exists, so positions cannot be transferred.

| Instruction | Signer | Notes |
|---|---|---|
| `create_market` | dealer | funds both reserves |
| `submit_report` | anyone | Ed25519 instruction for the Pyth payload, then this instruction, which calls the Lazer verifier |
| `finalise` | anyone | reads the NVDAx mint for the multiplier rule; pays the bounty |
| `buy` | buyer | Ed25519 instruction for the dealer quote, then this instruction |
| `claim` | position owner | payout |
| `refund` | position owner | void only |
| `sweep` | anyone | finalised markets, after the claim deadline |
| `close_market` | anyone | voided-before-sale or fully claimed |

**Sandbox markets** (flag set at creation, never changeable):

- prices come from the demo authority signing `submit_report` itself, never a Pyth payload
- timings, measured from creation: Friday mark at +5 s, buying until +45 s, Monday mark at +60 s, submission windows of 5 s, so finalisation is possible at +65 s
- the Monday scenario (a 0.5%, 2.5% or 6% fall) is chosen at random by the demo authority after buying closes, so a judge cannot buy knowing the result
- labelled "Sandbox" on every screen

Real markets never accept the demo authority.

## 11. Off-chain parts

- **Dealer service:** one server holding the Pyth Pro key and the dealer keys. It streams Pyth from one primary endpoint with a second as fallback, archives and publishes updates around each target, submits reports and calls `finalise` for real markets, signs quotes, runs the freeze rule, and acts as the sandbox demo authority.
- **Fee payer:** sandbox judge flows only (buy, claim, refund). The service builds the transaction with itself as fee payer and partially signs it; the judge's wallet adds its signature. Real-market and dealer transactions pay their own fees.
- **Frontend:** calculator, buy flow, locked view, and a settlement proof screen showing the signed price, session, timestamps, publishers, confidence and the escrow balance at finalisation.

## 12. Demo

- Devnet only, with demo USDC and a Token-2022 test mint "NVDAx (test)" carrying the scaled-UI extension; the dealer service holds its mint and multiplier authority. A faucet button gives judges both tokens.
- **Sandbox:** each judge starts a fresh sandbox weekend and runs buy, settlement and claim in about 70 seconds. A separate "multiplier change" sandbox scenario shows a void ending in refunds. The service changes the test mint's multiplier after the first sale, the Monday report is submitted, and `finalise` voids.
- **Real settlement before submission:** the weekend of Friday 27 November to Monday 30 November. Its Friday is an early close, so it also exercises the 12:59:30 ET rule, and Monday 30 November settles before the 5 December deadline. If the build is ready earlier, also settle 20 to 23 November. Transaction links go in the README.
- **Fallback** if neither real weekend settles cleanly: a recorded real Friday mark plus a sandbox Monday, labelled as such.
- **Recorded, not live:** the old-payload rejection and the tampered-payload rejection, as transaction links and unit tests.
- **README backtest table:** the last 20 NVDA weekends with the gap, what 200 contracts paid, and the premium the section 7 formula gives.

## 13. Open items

1. Measure confidence and publisher count at 09:31:30 and 15:59:30 on at least five weekdays, then fix `conf_cap_bps` per leg and `min_publishers`. Provisional values: Friday 10 bps, Monday 20 bps, 10 publishers. The spike measured only the first minute after 09:30 (p95 13.6 bps, 20 publishers).
2. Calibrate the section 7 coefficients against the backtest.
3. Confirm the build-week dates when the hackathon page publishes them.

## 14. Tests

- payout clamp at 0.5%, 1%, 2%, 5% and 10% falls, a rise, and rounding never exceeding escrow
- report eligibility: wrong feed, wrong session, carried-forward timestamp, outside window, wide confidence, too few publishers, wrong exponent, zero price, tampered signature, a 45-minute-old payload
- replacement ordering and ties
- `finalise` with and without a candidate; bounty paid to the stored submitter
- multiplier change after creation, change scheduled before Monday, past effective timestamp not treated as pending
- early-close Friday target
- escrow invariant across buys; finalise and void distributions
- quote: bad signature, wrong buyer, expired, nonce reuse and skip, premium of 0 or at least 1 USDC, over capacity, after close
- refund never swept; sweep only after the claim deadline; `close_market` cases
- sandbox: demo authority rejected on real markets; scenario hidden until buying closes
- no instruction exists to transfer a position
