# Monday Gap Cover: design spec

Status: version 3.1, 30 October 2026. Revised after three rounds of review by Muse and GPT; both now call it ready to plan. This file is plain ASCII on purpose so formulas survive copy and paste.
Target: Solana Foundation "Perps and Prediction Markets" hackathon, submissions close Saturday 5 December 2026

## 1. Product

An NVDAx holder keeps their shares over the weekend and buys a fully collateralised USDC payout that grows if NVDA is lower on Monday morning than on Friday afternoon.

Each contract pays nothing if NVDA falls 1% or less between the two marks, then rises linearly to $1.00 at a fall of 5% or more. A holder covers the 1% to 5% band with one contract per $25 of NVDAx: 200 contracts for a $5,000 position, paying $50 at a 2% fall and $200 at 5% or worse. The calculator always shows net loss after payout and premium, not just the payout.

Financially this is a cash-settled put spread on one weekend, and the pitch says so. Difference from Roster's Floor puts: "Roster sells exercisable, stock-settled Floors; Monday Gap Cover is a cash-settled, one-weekend loss-band reimbursement sized to xStocks you already hold, without moving or exercising those shares."

**Anyone can buy, deliberately.** The calculator sizes cover from the wallet's NVDAx balance or a sample portfolio, but the program does not check holdings. A Friday wallet snapshot was rejected because it cannot see NVDAx deposited in Kamino, liquidity pools or exchanges, and because it costs two to three days of a one-week build. The dealer's exposure is bounded by the hard contract cap, signed short-lived quotes, repricing from the live NVDAx price, and the quoting freeze (section 7). The pitch presents only that last point; the build-time reason stays in this spec. The pitch says "built for NVDAx holders" and never "holders only", "liquidation insurance" or "the open".

Kamino borrowers are a secondary use case, described as cash to rebuild collateral after Monday morning, not protection from liquidation at 09:30.

## 2. Names used everywhere

| Term | Meaning |
|---|---|
| Friday afternoon mark | The eligible NVDA report whose timestamp is closest to 15:59:30 ET Friday (12:59:30 ET on early-close Fridays) |
| Monday morning mark | The eligible NVDA report whose timestamp is closest to 09:31:30 ET Monday |
| Gap | (Friday mark - Monday mark) / Friday mark; positive when NVDA fell, negative when it rose |
| Dealer | One bot-owned account that sells cover and posts all collateral |
| Dealer service | One server running the keeper, the quote signer and the sandbox demo authority |

"Closest" always means closest in time, never in price. The word "open" appears in no user-facing text.

## 3. Scope

In: one market per weekend on NVDA; buy, settle, claim, refund, sweep, close; a sandbox mode for judges; a one-table backtest in the README.

Out, in writing: other stocks, selling cover back, transferable positions, public liquidity deposits, Kamino integration, implied volatility, a secondary market, mainnet real-money trading, a history page.

## 4. Lifecycle and states

States: `Created -> FridayFinal -> (buying until close) -> MondayFinal`, or `Voided` from `Created` or `FridayFinal`.

1. **Create.** At least one hour before the Friday target, the dealer creates the market with immutable parameters (section 6) and pre-funds `CollateralReserve` with `max_contracts * 1_000_000` and `BountyReserve` with `2 * bounty`. The dealer service refuses to create a market if Pyth's schedule for feed 1314 shows Friday or Monday as a holiday, or if the NVDAx mint has a multiplier change scheduled between now and the Monday target. It moves the Friday target to 12:59:30 ET on early-close Fridays. The program cannot read Pyth's schedule; it enforces only the UTC targets fixed at creation.
2. **Friday mark.** Reports submitted per section 5, then `finalise_friday` moves the market to `FridayFinal` or `Voided`. Buying opens only in `FridayFinal`.
3. **Buying.** From `FridayFinal` until Sunday 17:50 ET, using dealer-signed quotes (section 7).
4. **Locked.** Sunday 17:50 ET to the Monday mark. The app shows an estimated payout from the live NVDAx reference price, labelled as an estimate.
5. **Monday mark.** Reports submitted per section 5, then `finalise_monday` moves the market to `MondayFinal` or `Voided` and computes payouts.
6. **Claim.** In `MondayFinal`, each buyer may claim their payout into their own USDC account.
7. **Void.** In `Voided`, each buyer may claim a refund of their premium.
8. **Sweep and close.** Section 9.

## 5. Settlement rules

Applies to both marks. For target time T:

- An eligible report is a Pyth Pro update for feed 1314 that passes Pyth's Lazer verifier (`pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`), called by CPI with `ed25519_instruction_index = 0`. The transaction must carry the Ed25519 signature instruction at index 0 and `submit_report` at index 1; the program checks both indexes through the instructions sysvar and rejects any other layout. Compute-budget instructions, if any, come after index 1. In the report:
  - `marketSession == regular`
  - `feedUpdateTimestamp == timestampUs` exactly
  - `T - 5s <= feedUpdateTimestamp <= T + 5s`
  - `price > 0`
  - `exponent == market.exponent` (set to -5 at creation for feed 1314)
  - `confidence * 10_000 <= price * conf_cap_bps` for that leg, in checked i128 (no division)
  - `publisherCount >= min_publishers`
- Anyone may submit an eligible report during the submission window, from T until T + 7 minutes (sandbox: T + 5 seconds). The first becomes the candidate, and its submitter is stored.
- A later eligible report replaces the candidate if it ranks lower on `(abs(feedUpdateTimestamp - T), feedUpdateTimestamp, sha256(payload))`. The order is total, so the outcome does not depend on submission order.
- After the window closes, anyone may call `finalise_friday` or `finalise_monday` for that leg. With a candidate, the mark is fixed and the stored submitter receives that leg's bounty from `BountyReserve`. Without one, the market moves to `Voided`.
- The submitter pays the Lazer verifier's treasury fee (1 lamport) and its own transaction fee.
- The verifier checks signatures only; the spike showed it accepts a 45-minute-old payload. Every check above runs in this program.
- The dealer service publishes every signed update it receives within T - 5s to T + 5s to a public URL as it arrives, so anyone can submit a closer report without a Pyth Pro key. The program cannot prove that archive is complete, and the README says so: challenges are permissionless given the published archive, and the dealer could in principle withhold a report. Anyone with their own Pyth Pro access can still challenge.

## 6. Market parameters

Fixed at creation, never changeable:

- feed id (1314), price exponent (-5), NVDAx mint, USDC mint
- Friday and Monday target times (UTC), buying close time
- band lower and upper (100 and 500 bps)
- conf_cap_bps for each leg, min_publishers, eligibility half-window (5 s), submission window (7 min, or 5 s on sandbox markets)
- maximum contracts, bounty per leg (100_000 = 0.10 USDC), claim deadline (30 days after `MondayFinal`)
- dealer quote-signing key, quote maximum lifetime (90 s)
- sandbox flag, and on sandbox markets the demo-authority key and the sandbox mode (section 10)
- NVDAx effective scaled-UI multiplier at creation

After the first sale, the dealer can stop issuing quotes and nothing else.

## 7. Pricing and quotes

The dealer service prices off-chain when a quote is requested.

**NVDAx reference price and liquidity.** The service asks Jupiter for a 1,000 USDC to NVDAx quote, receiving `t` NVDAx raw units, then for a quote selling exactly `t` back to USDC, receiving `u` USDC. With the mint's current effective multiplier `k` and its decimals `d` read from the mint account (8 for NVDAx):

- `shares = t * k / 10^d`
- `nvdax_price = 1000 / shares` (USD per share)
- `round_trip_bps = (1000 - u) * 10_000 / 1000`

`f_x` is the NVDAx reference price recorded when the Friday mark finalised.

**Premium per contract:**

- `m = (f_x - nvdax_price) / f_x`, the NVDAx fall since the Friday mark (negative if it rose)
- For each of the last 104 historical weekend gaps `g_i` (as decimals, positive = fall): `p_i = clamp((g_i + m - 0.01) / 0.04, 0, 1)`
- `base = mean(p_i)` in USDC
- `uncertainty = 0.25 * base + 0.005`
- `u = contracts_sold / max_contracts`
- `utilisation = base * 2 * u^2` (the inventory-skew curve from the Avellaneda-Stoikov simulator, presented as a utilisation curve)
- `reserve = 0.002`
- `premium_per_contract = base + uncertainty + utilisation + reserve`, rounded up to the base unit

If `premium_per_contract >= 0.95` the service issues no quote. Coefficients are provisional and get checked against the backtest on build day one.

**Freeze.** No quotes are issued if `nvdax_price` moved more than 5% within 30 minutes, `round_trip_bps > 100`, or Jupiter returns no route. Quoting resumes automatically once 15 minutes pass with none of those true. Nobody resumes it by hand.

**The quote** is a message signed with the dealer's Ed25519 key over: market, buyer, contracts, premium_per_contract, expiry, nonce.

- The service reads the buyer's `Position.last_nonce` and signs with `nonce = last_nonce + 1`.
- A refreshed quote reuses the same nonce until a buy succeeds.
- `buy` takes no amount arguments. Contracts and premium come only from the signed quote, and `total_premium = contracts * premium_per_contract`.

**On-chain checks in `buy`:**

- the Ed25519 instruction is at transaction index 0 and `buy` at index 1 (checked through the instructions sysvar), and it is by the dealer's key over exactly those fields
- `0 < premium_per_contract < 1_000_000`
- not expired by the Solana clock
- `nonce == position.last_nonce + 1`
- signer equals the quote's buyer
- market is in `FridayFinal` and before buying close
- `contracts_sold + contracts <= max_contracts`

The program does not check whether the premium is fair. It enforces the dealer's signature, not the pricing model. The app shows the formula and inputs for every quote, and the README says so. The app refreshes quotes automatically before they expire.

## 8. Void conditions

All objective, none chosen by the dealer:

- no eligible report for a mark by the end of its submission window
- at `finalise_friday` or `finalise_monday`, the NVDAx mint's effective multiplier differs from the one recorded at creation
- at either finalisation, `new_multiplier_effective_timestamp` falls after market creation and at or before the Monday target, unless that change is already the effective multiplier recorded at creation

The effective multiplier at time t is `new_multiplier` if `t >= new_multiplier_effective_timestamp`, otherwise `multiplier`. The program sees only the mint's state when an instruction runs, so it cannot detect a change made and reversed between finalisations; the dealer service's creation check (section 4) covers scheduled changes.

## 9. Money

All amounts in USDC base units (6 decimals). All arithmetic is checked i128. Intermediates may be negative; an overflow, or any transfer of a negative amount, fails the instruction.

- **Create:** dealer deposits `max_contracts * 1_000_000` into `CollateralReserve` and `2 * bounty` into `BountyReserve`. Both are owned by the market PDA.
- **Buy** (signed by the buyer only): buyer pays `total_premium` into `Escrow`; the program moves `contracts * 1_000_000 - total_premium` from `CollateralReserve` into `Escrow`. Invariant until `MondayFinal`: `Escrow == contracts_sold * 1_000_000`. `total_premiums` and `open_positions` (incremented on a buyer's first buy) are tracked on `Market`.
- **finalise_friday:** pays the Friday bounty; stores the Friday price.
- **finalise_monday:**
  - `gap_bps = (friday - monday) * 10_000 / friday`, signed, negative on a rise
  - `payout_per_contract = clamp((gap_bps - 100) * 1_000_000 / 400, 0, 1_000_000)`, rounded down; a rise gives 0
  - `Escrow` keeps `contracts_sold * payout_per_contract`; the remainder and the unused `CollateralReserve` go to the dealer; the Monday bounty is paid
- **Void:** `Escrow` keeps `total_premiums` for refunds; the rest of `Escrow`, the unused `CollateralReserve` and any unpaid bounties go to the dealer.
- **Claim / refund:** paid only to the position owner's USDC account; marks the position closed and decrements `open_positions`. A zero payout is still claimed to close the position.
- **Sweep:** in `MondayFinal`, after the claim deadline, anyone may sweep the remaining `Escrow` to the dealer; this sets `swept`.
- **Refunds after a void never expire and are never swept.**
- **close_market:** anyone may close a market that is `Voided` with no sales, or that has `open_positions == 0`, or that is `swept`; rent returns to the dealer.

## 10. Accounts, instructions and signers

Accounts:

- `Market`: parameters, state, Friday and Monday candidates and their submitters, `contracts_sold`, `total_premiums`, `open_positions`, `swept`
- `Escrow`, `CollateralReserve`, `BountyReserve`: USDC accounts owned by the market PDA
- `Position` PDA seeded by [market, buyer]: contracts, premium paid, last nonce, closed flag

No position token exists, so positions cannot be transferred.

| Instruction | Signer | Notes |
|---|---|---|
| `create_market` | dealer | funds both reserves |
| `submit_report` | anyone (real); demo authority (sandbox) | real: Ed25519 instruction for the Pyth payload at index 0, this instruction at index 1, which calls the Lazer verifier |
| `finalise_friday` | anyone | reads the NVDAx mint; pays the Friday bounty |
| `finalise_monday` | anyone | reads the NVDAx mint; computes payout; pays the Monday bounty |
| `buy` | buyer | Ed25519 instruction for the dealer quote at index 0, this instruction at index 1 |
| `claim` | position owner | `MondayFinal` |
| `refund` | position owner | `Voided` |
| `sweep` | anyone | `MondayFinal`, after the claim deadline |
| `close_market` | anyone | see section 9 |

**Sandbox markets** (flag set at creation, never changeable). The program enforces these overrides:

- `submit_report` takes the price as an argument and must be signed by the market's demo-authority key; Pyth payloads are not accepted
- submission window 5 s; targets from creation: Friday at +5 s, buying close at +45 s, Monday at +60 s, so `finalise_monday` is possible at +65 s
- Two modes, chosen when the judge starts a sandbox:
  - **gap:** after buying closes, the demo authority picks a Monday fall of 0.5%, 2.5% or 6% at random, so a judge cannot buy knowing the result
  - **multiplier void:** after the first sale the dealer service changes the test mint's multiplier, then submits the Monday price, and `finalise_monday` voids
- labelled "Sandbox" on every screen

Real markets never accept the demo authority.

## 11. Off-chain parts

- **Dealer service:** one server holding the Pyth Pro key and the dealer and demo-authority keys. It streams Pyth from all three Pyth Pro endpoints and drops duplicates by payload hash, archives and publishes updates around each target, submits reports and calls the finalise instructions for real markets, signs quotes, runs the freeze rule, and acts as the sandbox demo authority.
- **Fee payer:** sandbox judge flows only (buy, claim, refund). The service builds the transaction with itself as fee payer and partially signs; the judge's wallet adds its signature. Real-market and dealer transactions pay their own fees.
- **Frontend:** calculator, buy flow, locked view, and a settlement proof screen showing the signed price, session, timestamps, publishers, confidence and the escrow balance at finalisation.

## 12. Demo

- Devnet only, with demo USDC and a Token-2022 test mint "NVDAx (test)" carrying the scaled-UI extension; the dealer service holds its mint and multiplier authority. A faucet button gives judges both tokens.
- **Sandbox:** each judge starts a fresh sandbox market in gap mode and runs buy, settlement and claim in about 70 seconds, or in multiplier-void mode to see refunds.
- **Real settlement before submission:** the weekend of Friday 27 November to Monday 30 November. Its Friday is an early close, so it also exercises the 12:59:30 ET rule, and Monday 30 November settles before the 5 December deadline. If the build is ready earlier, also settle 20 to 23 November. Transaction links go in the README.
- **Fallback** if neither real weekend settles cleanly: a recorded real Friday mark plus a sandbox Monday, labelled as such.
- **Recorded, not live:** the old-payload rejection and the tampered-payload rejection, as transaction links and unit tests.
- **README backtest table:** the last 20 NVDA weekends with the gap, what 200 contracts paid, and the premium the section 7 formula gives.

## 13. Open items

1. Measure confidence and publisher count at 09:31:30 and 15:59:30 ET on at least five weekdays, then fix `conf_cap_bps` per leg and `min_publishers`. Provisional values: Friday 10 bps, Monday 20 bps, 10 publishers. The spike measured only the first minute after 09:30 (p95 13.6 bps, 20 publishers).
2. Calibrate the section 7 coefficients against the backtest.
3. Confirm the build-week dates when the hackathon page publishes them. If the build cannot finish before 27 November, section 12's fallback applies.

## 14. Tests

- payout at 0.5%, 1%, 2%, 5% and 10% falls and at a rise (pays 0, does not fail); rounding never exceeds escrow
- transaction layout: Ed25519 instruction not at index 0, program instruction not at index 1
- report eligibility: wrong feed, wrong session, carried-forward timestamp, outside window, confidence just above the cap, too few publishers, wrong exponent, zero price, tampered signature, a 45-minute-old payload
- replacement ordering and ties
- `finalise_friday` and `finalise_monday` with and without a candidate; bounty paid to the stored submitter; buying impossible before `FridayFinal`
- multiplier differs at either finalisation; change scheduled inside the period; past effective timestamp not treated as pending
- early-close Friday target
- escrow invariant across buys; distributions on `MondayFinal` and `Voided`
- quote: bad signature, wrong buyer, expired, nonce reuse and skip, refreshed quote reusing its nonce, premium of 0 or at least 1 USDC, over capacity, after close
- zero-payout claim closes the position; refunds never swept; sweep only after the deadline; `close_market` in each allowed case and refused otherwise
- sandbox: demo authority rejected on real markets; gap scenario not chosen before buying closes
- no instruction exists to transfer a position
