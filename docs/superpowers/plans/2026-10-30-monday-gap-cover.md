# Monday Gap Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A devnet Solana program, dealer service and web app that sell fully collateralised one-weekend NVDA gap cover and settle it from signed Pyth Pro prices.

**Architecture:** An Anchor program holds all money and enforces every settlement and quote rule on-chain. One Node service streams Pyth, prices and signs quotes, runs the keeper and the sandbox demo authority. A React app is the only user surface.

**Tech Stack:** Rust + Anchor 0.30.1 (installed), no Pyth crates: a raw CPI to the Lazer verifier and an in-house payload parser (the published `pyth-lazer-solana-contract` 0.11 requires anchor-lang ^1.2.1 and solana-program ^4, checked on crates.io 30 Oct 2026). TypeScript on Node 25 (fallback Node 22), `solana-bankrun` 0.4 / `anchor-bankrun` 0.5 + vitest for program tests (fallback `litesvm`), `ws` + Jupiter lite-api in the service, React + Vite for the app.

**Spec:** `docs/superpowers/specs/2026-10-30-monday-gap-cover-design.md` (v3.2). Section numbers below (§) refer to it.

## Global Constraints

- Feed id 1314, exponent -5, band 100 to 500 bps, eligibility half-window 5 s, submission window 7 min, bounty 100_000 per leg, quote lifetime 90 s, claim deadline 30 days (§6).
- All program arithmetic is checked i128; intermediates may be negative; overflow or a negative transfer fails (§9).
- Confidence check is `confidence * 10_000 <= price * conf_cap_bps`, never a division (§5).
- Ed25519 instruction at transaction index 0, program instruction at index 1, and the Ed25519 offsets header checked, for both `submit_report` and `buy` (§5, §10).
- Report replacement is strict on `(abs(feed_ts - T), feed_ts)`; exact ties keep the earlier submission (§5).
- `buy` takes no amount arguments; contracts and premium come only from the signed quote (§7).
- Lazer verifier: program `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`, instruction `verify_message(message_data: bytes, ed25519_instruction_index: u16 = 0, signature_index: u8 = 0)`, accounts `payer, storage (3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL), treasury (opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7 on devnet; read it from storage), system_program, instructions_sysvar`.
- No user-facing text contains the word "open" anywhere; use "Friday afternoon mark", "Monday morning mark", "buying", "active positions" (§2).
- Devnet only. The Pyth Pro key and dealer keys never reach the browser (§11).
- Commits carry no AI attribution trailers (owner's standing preference for public repos).
- Layout: `programs/gap_cover/`, `tests/`, `service/`, `app/`, `scripts/`, `fixtures/`, `data/`.

## Review Focus

1. A judge opens the app when no real market is buying: the app still shows the market state and offers the sandbox. Test in Task 13.
2. The same buyer requests quotes from two tabs: both carry the same nonce; the first buy succeeds and the second fails with `QuoteUsed`, never a double charge. Test in Task 6.
3. Pyth delivers duplicate, out-of-order or ineligible updates: the keeper submits only eligible updates, closest first, and never resubmits one the program rejected. Test in Task 9.
4. A buyer lacks USDC for the premium: the app says so before asking for a signature. Test in Task 13.
5. A Monday mark exactly at a band edge (100 or 500 bps, or 1 bp past): payout is exactly 0, 2_500 or 1_000_000, and escrow never goes short through rounding. Test in Task 2.

## If time runs short, cut in this order

1. Task 0 Step 5 (keep provisional caps). 2. The 20 to 23 November rehearsal weekend. 3. Task 10 calibration (keep coefficients). 4. Three-endpoint streaming in Task 9 (one endpoint with failover). 5. Proof-screen escrow detail in Task 13.

Never cut: the Lazer verification path, quote-nonce tests, multiplier-void tests, payout/refund tests, the sandbox cycle, the proof screen's price/session/timestamp.

---

### Task 0: Mark-time logger (start now; independent of the build week)

**Files:** Create `scripts/measure-marks.mjs`, `scripts/com.monday-gap-cover.measure.plist`, `scripts/README-measure.md`, `.gitignore` (`.env*`, `node_modules/`, `target/`, `.anchor/`, `data/*.csv` excluded from git except `data/marks.csv`).

**Interfaces:** Produces `data/marks.csv`: `date,leg,target_utc,updates,session,conf_bps_p50,conf_bps_p95,conf_bps_max,publishers_min,publishers_p50,fresh_share`.

- [ ] **Step 1:** Create `.gitignore` first, then `measure-marks.mjs`: subscribe to feed 1314 (properties `price, exponent, confidence, publisherCount, marketSession, feedUpdateTimestamp`, `fixed_rate@200ms`, JSON delivery, `PYTH_PRO_TOKEN` from `.env`) from T - 30 s to T + 30 s for T = 15:59:30 ET and 09:31:30 ET, appending one row per leg. Reuse the subscription in `../gapcover-spike/smoke2.mjs`.
- [ ] **Step 2:** Run by hand at the next mark; check a row with `session = regular` and `fresh_share = 1`.
- [ ] **Step 3:** Install the launchd job for weekdays at 09:30 and 15:58 ET (the Mac runs on IST, which has no daylight saving; after US clocks change on 1 November 2026 the marks fall at 20:01:30 and 02:29:30 IST, so the plist starts the job at 20:00 and 02:28 IST Monday to Friday local, and the README states the conversion; the script itself computes T in America/New_York, so a wrong start time only wastes a run).
- [ ] **Step 4:** Commit: `git commit -m "Log Pyth confidence and publishers at both mark times"`.
- [ ] **Step 5 (after five weekdays):** per leg, `conf_cap_bps = max(provisional, ceil(1.5 * p95_of_daily_p95))` with provisionals Friday 10, Monday 20; `min_publishers = 10` unless any observed minimum is below 10, then `observed_min - 1`. Write the values into `scripts/README-measure.md` and `service/src/config.ts`. Not a gate for Task 14: provisionals are used if this is not done.

### Task 1: Toolchain spike and bankrun harness (go/no-go before any program code)

**Files:** Create `Anchor.toml`, `Cargo.toml`, `programs/gap_cover/{Cargo.toml,src/lib.rs}`, `package.json`, `vitest.config.ts`, `tests/harness.ts`, `tests/harness.test.ts`, `scripts/dump-lazer.sh`, `fixtures/lazer/{pytd2.so,storage.json,treasury.json}`, `fixtures/pyth/{regular-2026-10-29.json,premarket-2026-10-29.json}` (copies of `../gapcover-spike/sample-*.json`).

**Interfaces:** Produces
- `startHarness(): Promise<{ context, provider, program, payer, usdcMint, clock }>` loading `gap_cover`, the dumped Lazer program, storage, and treasury (treasury pre-funded with 10_000_000 lamports)
- `warpTo(context, unixSeconds): Promise<void>`
- `fixturePayload(name): Buffer` (hex `solana.data` decoded to 158 bytes)
- `createScaledMint(context, { decimals: 8, multiplier: number }): Promise<PublicKey>` and `scheduleMultiplier(context, mint, newMultiplier, effectiveTs)`: Token-2022 mint with the `ScaledUiAmount` extension, authority = harness payer

- [ ] **Step 1:** `scripts/dump-lazer.sh` dumps the program, storage and treasury from devnet. Run it.
- [ ] **Step 2:** Write tests: `harness boots under the current Node`, `verifies a genuine fixture through the Lazer program` (raw `[createEd25519Instruction(payload, 1, 12), verify_message]`, as in `../gapcover-spike/verify.mjs`), `rejects a tampered fixture`, `scaled mint reports multiplier 1.0 then 1.0025 after the scheduled timestamp`.
- [ ] **Step 3:** `npx vitest run tests/harness.test.ts`; expect FAIL.
- [ ] **Step 4:** Implement. If `solana-bankrun` fails to load under Node 25, retry under Node 22; if it still fails, switch the harness to `litesvm` and record the choice in `README.md`. If the bankrun runtime lacks Token-2022, dump `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` from devnet into the harness.
- [ ] **Step 5:** Run; expect PASS. This is the go/no-go: do not start Task 3 until all four pass.
- [ ] **Step 6:** Commit: `git commit -m "Set up harness with Pyth's Lazer verifier and a scaled-UI test mint"`.

### Task 2: Settlement maths (can run in parallel with Task 1)

**Files:** Create `programs/gap_cover/src/math.rs` (tests in-file).

**Interfaces:** Produces
- `pub fn gap_bps(friday: i64, monday: i64) -> Result<i128>`
- `pub fn payout_per_contract(gap_bps: i128, lower_bps: u16, upper_bps: u16) -> u64`
- `pub fn conf_ok(confidence: u64, price: i64, cap_bps: u16) -> bool`
- `pub fn rank_key(feed_ts_us: i64, target_us: i64) -> (u64, i64)` (lower wins; replacement needs strictly lower)
- `pub fn effective_multiplier_bits(multiplier_bits: u64, new_multiplier_bits: u64, effective_ts: i64, at: i64) -> u64` (works on raw `PodF64` bits; no float arithmetic on-chain)

- [ ] **Step 1:** Write failing tests:

```rust
#[test] fn payout_band() {
    assert_eq!(payout_per_contract(gap_bps(10_000, 9_950).unwrap(), 100, 500), 0);
    assert_eq!(payout_per_contract(100, 100, 500), 0);
    assert_eq!(payout_per_contract(101, 100, 500), 2_500);
    assert_eq!(payout_per_contract(200, 100, 500), 250_000);
    assert_eq!(payout_per_contract(500, 100, 500), 1_000_000);
    assert_eq!(payout_per_contract(1_000, 100, 500), 1_000_000);
    assert_eq!(payout_per_contract(gap_bps(10_000, 10_300).unwrap(), 100, 500), 0);
}
#[test] fn conf_cross_multiplied() {
    assert!(conf_ok(21_057, 21_430_043, 10));
    assert!(!conf_ok(21_457, 21_430_043, 10));
}
#[test] fn rank_strict() {
    let t = 1_000_000_000;
    assert!(rank_key(t + 200_000, t) < rank_key(t - 300_000, t));
    assert!(rank_key(t - 200_000, t) < rank_key(t + 200_000, t));
    assert_eq!(rank_key(t + 5, t), rank_key(t + 5, t)); // exact tie: not strictly lower, keeps earlier
}
#[test] fn multiplier_effective() {
    let (a, b) = (1.0f64.to_bits(), 1.0025f64.to_bits());
    assert_eq!(effective_multiplier_bits(a, b, 100, 200), b);
    assert_eq!(effective_multiplier_bits(a, b, 300, 200), a);
}
```

- [ ] **Step 2:** `cargo test -p gap_cover math`; expect FAIL.
- [ ] **Step 3:** Implement (`payout = clamp((gap - lower) * 1_000_000 / (upper - lower), 0, 1_000_000)` in i128).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Add settlement maths with band-edge tests"`.

### Task 3: Payload parser, Ed25519 checks and Lazer CPI

**Files:** Create `programs/gap_cover/src/pyth.rs`, `programs/gap_cover/src/sigverify.rs`, `programs/gap_cover/src/lazer.rs`; test data `programs/gap_cover/tests/data/{regular,premarket}.hex`.

**Interfaces:**
- Consumes: `conf_ok` (Task 2).
- Produces:
  - `pub struct PriceReport { timestamp_us: i64, feed_id: u32, price: i64, exponent: i16, confidence: u64, publishers: u16, session: MarketSession, feed_update_ts_us: i64 }`
  - `pub fn parse_report(signed_message: &[u8], feed_id: u32) -> Result<PriceReport>`: parses the Solana-format envelope (4-byte magic, 64-byte signature, 32-byte public key, u16 payload length, payload) and the little-endian payload per Pyth's documented binary format, using only the fixture-verified property order requested by the service (`price, exponent, confidence, publisherCount, marketSession, feedUpdateTimestamp`)
  - `pub fn check_eligible(r: &PriceReport, market: &Market, leg: Leg) -> Result<()>` with errors `WrongFeed, WrongSession, CarriedForward, OutsideWindow, ZeroPrice, WrongExponent, WideConfidence, TooFewPublishers`
  - `pub fn require_ed25519_at_index0(ix_sysvar: &AccountInfo, expected_signer: Option<Pubkey>) -> Result<(Pubkey, Vec<u8>)>`: asserts current instruction index is 1 and instruction 0 is the Ed25519 program with exactly one signature, then reads the 14-byte offsets header and asserts the signature, public key and message offsets all point into the expected instruction at the expected positions with the expected message length; returns signer and message
  - `pub fn lazer_verify(accounts, signed_message: &[u8]) -> Result<()>`: raw `invoke` of `verify_message` with discriminator `sha256("global:verify_message")[..8]`, Borsh `(Vec<u8>, u16 = 0, u8 = 0)`, accounts per Global Constraints

- [ ] **Step 1:** Write failing tests: `parse_report(regular.hex)` gives price 21_430_043, exponent -5, confidence 21_057, publishers 20, session Regular, `feed_update_ts_us == timestamp_us == 1_793_280_669_400_000`; premarket gives PreMarket; one `check_eligible` test per error; `require_ed25519_at_index0` rejects a header whose message offset points at a different instruction, and one with two signatures.
- [ ] **Step 2:** `cargo test -p gap_cover pyth sigverify`; expect FAIL.
- [ ] **Step 3:** Implement. The Lazer signature covers exactly the bytes parsed, so a parsing mistake can misread a field but cannot accept a forged price; the fixture tests guard the field reads.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Parse Pyth payloads, check Ed25519 layout and call the Lazer verifier"`.

### Task 4: `create_market` and `submit_report`

**Files:** Create `programs/gap_cover/src/state.rs`, `src/instructions/create_market.rs`, `src/instructions/submit_report.rs`; test `tests/create_and_report.test.ts`.

**Interfaces:**
- Produces:
  - `Market` with all §6 parameters plus `state: MarketState { Created, FridayFinal, MondayFinal, Voided }`, `friday: Option<Candidate>`, `monday: Option<Candidate>`, `contracts_sold: u32`, `total_premiums: u64`, `open_positions: u32`, `swept: bool`, `payout_per_contract: u64`, `buying_closed: bool`
  - `Candidate { price: i64, feed_ts_us: i64, submitter: Pubkey }`
  - `create_market(params: MarketParams)`; market PDA `["market", dealer, friday_target_ts.to_le_bytes()]`; vault authority PDA `["vault", market]` owns `escrow`, `collateral_reserve`, `bounty_reserve`
  - `submit_report(leg: Leg, signed_message: Vec<u8>)` (real markets)
  - `submit_sandbox_price(leg: Leg, price: i64)` (sandbox; signer `demo_authority`; Friday at creation sets `FridayFinal` immediately; Monday sets `buying_closed` and finalises in Task 7)
- [ ] **Step 1:** Write failing tests: reserves hold `max_contracts * 1_000_000` and `200_000`; real market with Monday target 1_793_280_672: submitting the regular fixture after warping to the target makes it the candidate with the submitter stored; a second identical-timestamp submission does not replace it; Ed25519 at index 1 fails `WrongInstructionLayout`; submission after T + 7 min fails `WindowClosed`; Monday report before `FridayFinal` fails `WrongState`; Friday report after `FridayFinal` fails `WrongState`; real market created under 3_600 s before Friday target fails; sandbox: `submit_report` rejected, non-authority `submit_sandbox_price` rejected, Friday sandbox price moves straight to `FridayFinal`; real market rejects `submit_sandbox_price`.
- [ ] **Step 2:** `npx vitest run tests/create_and_report.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Create markets and accept verified reports"`.

### Task 5: `finalise_friday`

**Files:** Create `programs/gap_cover/src/instructions/finalise.rs`; test `tests/finalise_friday.test.ts`.

**Interfaces:** Produces `finalise_friday()` (anyone): with a candidate, `FridayFinal` and 100_000 to the stored submitter's USDC account; without one, `Voided` with all reserves returned to the dealer; reads the NVDAx mint and voids under §8.

- [ ] **Step 1:** Write failing tests for each branch, `WindowOpen` before T + 7 min, and a multiplier scheduled before the Monday target voiding (using `scheduleMultiplier` from Task 1).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Finalise the Friday afternoon mark"`.

### Task 6: `buy` with dealer-signed quotes

**Files:** Create `src/instructions/buy.rs`, `src/quote.rs`; test `tests/buy.test.ts`.

**Interfaces:** Produces
- Quote message, 96 bytes little-endian: `b"MGCQ"` (4) | market (32) | buyer (32) | contracts u32 (4) | premium_per_contract u64 (8) | expiry i64 (8) | nonce u64 (8)
- `pub fn decode_quote(msg: &[u8]) -> Result<Quote>` rejecting any length other than 96
- `buy()` with no arguments; `Position` PDA `["position", market, buyer]` = `{ contracts: u32, premium_paid: u64, last_nonce: u64, closed: bool }`

- [ ] **Step 1:** Write failing tests: a 95- or 97-byte message fails `BadQuote`; a valid quote moves `total_premium` from the buyer and `contracts * 1_000_000 - total_premium` from the reserve, so escrow equals `contracts_sold * 1_000_000`; `open_positions` increments only on a buyer's first buy; rejections for signer not the dealer, buyer mismatch, expired, `nonce != last_nonce + 1`, premium 0, premium 1_000_000, over capacity, before `FridayFinal`, after buying close or `buying_closed`, Ed25519 not at index 0; Review Focus 2 (two quotes, same nonce, second fails `QuoteUsed`).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Sell cover against dealer-signed quotes"`.

### Task 7: `finalise_monday` and void distribution

**Files:** Modify `src/instructions/finalise.rs`; test `tests/finalise_monday.test.ts`.

**Interfaces:** Produces `finalise_monday()` (anyone; on sandbox markets callable as soon as the Monday sandbox price is set).

- [ ] **Step 1:** Write failing tests: 2% fall sets `payout_per_contract = 250_000`, escrow keeps `contracts_sold * 250_000`, the dealer receives escrow remainder plus unused reserve, the Monday bounty goes to the stored submitter; a rise sets 0 without failing; no candidate voids; multiplier differs at Monday voids; on `Voided`, escrow keeps exactly `total_premiums` and the dealer receives the rest of escrow, the unused reserve and any unpaid bounty in the same instruction.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Finalise the Monday morning mark and distribute funds"`.

### Task 8: `claim`, `refund`, `sweep`, `close_market`

**Files:** Create `src/instructions/settle_out.rs`; test `tests/settle_out.test.ts`.

- [ ] **Step 1:** Write failing tests: claim pays `contracts * payout_per_contract` into the owner's account and closes the position; a zero-payout claim closes it; double claim fails; claim to another wallet's token account fails; refund pays `premium_paid` only in `Voided`, still works 60 days later; sweep fails before 30 days and in `Voided`, succeeds after 30 days in `MondayFinal`; close fails with open positions, succeeds when `open_positions == 0`, when swept, or when voided with no sales; `idl has no transfer instruction` asserts the instruction names are exactly `create_market, submit_report, submit_sandbox_price, finalise_friday, finalise_monday, buy, claim, refund, sweep, close_market`.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run && cargo test -p gap_cover`; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Pay claims and refunds; sweep and close markets"`.

### Task 9: Devnet deployment, test mint and demo USDC

**Files:** Create `scripts/deploy-devnet.sh`, `scripts/create-test-mints.ts`, `scripts/schedule.ts`; test `tests/schedule.test.ts` with fixture `fixtures/pyth/symbols-1314.json` (saved response of the public `https://pyth.dourolabs.app/v1/symbols?query=NVDA`, verified 30 Oct 2026 to need no auth and to carry the holiday schedule).

**Interfaces:** Produces devnet program id; "NVDAx (test)" Token-2022 mint (8 decimals, ScaledUiAmount) and a "USDC (demo)" mint, both with authority held by the dealer key; `scheduleTargets(dateEt): { fridayTargetUtc, mondayTargetUtc } | "holiday"`.

- [ ] **Step 1:** Write failing tests: `scheduleTargets` gives 12:59:30 ET for Friday 27 November 2026, "holiday" for 26 November, 15:59:30 ET and 09:31:30 ET for 20 and 23 November.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement; `anchor deploy --provider.cluster devnet`; create both mints; mint the dealer 10_000 demo USDC (real-weekend `max_contracts` = 5_000).
- [ ] **Step 4:** Run; expect PASS; confirm the program on Solana Explorer (devnet).
- [ ] **Step 5:** Commit: `git commit -m "Deploy to devnet with test mints and schedule handling"`.

### Task 10: Dealer service, Pyth side

**Files:** Create `service/{package.json,src/config.ts,src/pyth.ts,src/archive.ts,src/keeper.ts}`; tests `service/test/{archive,keeper}.test.ts`.

**Interfaces:** Produces
- `streamNvda(onUpdate: (u: SignedUpdate) => void): () => void` over all three endpoints; `SignedUpdate = { messageHex, feedTsUs: bigint, timestampUs: bigint, price: bigint, exponent: number, confidence: bigint, publishers: number, session: string, hash: string }`
- `Archive.add(u)` (dedup by hash), `Archive.eligible(targetUs, params): SignedUpdate[]` applying every §5 bullet, sorted by `(|feedTs - T|, feedTs)`; served at `GET /archive/:market/:leg`
- `Keeper.run(market)`: from T + 2 s submits the best eligible update; resubmits only an update strictly better than the on-chain candidate; never resubmits a rejected one; calls the right finalise after T + 7 min

- [ ] **Step 1:** Write failing tests for Review Focus 3: duplicates stored once; out-of-order arrival yields the right best; updates failing session, freshness, confidence, publishers, exponent or price are excluded; a rejected submission is marked and skipped.
- [ ] **Step 2:** `cd service && npx vitest run`; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Stream, archive and submit Pyth reports"`.

### Task 11: Dealer service, pricing, quotes, sandbox and relay

**Files:** Create `service/src/{jupiter.ts,pricing.ts,quote.ts,sandbox.ts,relay.ts,server.ts}`, `service/data/nvda-gaps.csv`, `scripts/build-gaps.mjs`; tests `service/test/{pricing,quote,relay}.test.ts`.

**Interfaces:** Produces
- `nvdaxReference(): Promise<{ price, roundTripBps, multiplier, decimals } | null>` against the real mainnet NVDAx mint via Jupiter (§7)
- `premiumPerContract({ gaps, m, sold, max }): number | null` (null at or above 0.95)
- `Freeze.update(ref, nowMs)`, `Freeze.isFrozen(nowMs)`; sandbox markets ignore the freeze and fall back to the last good reference
- `encodeQuote(q): Buffer` (96 bytes, Task 6 layout), `signQuote(q, dealerKey)`
- HTTP: `GET /quote?market&buyer&contracts`, `POST /sandbox/start {mode}`, `POST /sandbox/bell {market}`, `POST /relay`, `POST /faucet {wallet}`
- [ ] **Step 1:** Write failing tests: gaps all 0 and m 0 gives premium 0.007; gaps `[0.02]`, m 0, sold 0 gives 0.3195; at sold = max utilisation adds `2 * base`; 0.95 or more returns null; each freeze trigger and the 15-minute lift; `encodeQuote` output is 96 bytes and decodes with Task 6's Rust `decode_quote` test vector; nonce from `Position.last_nonce` reused across refreshes; `sandbox.bell` picks the Monday fall only after buying is closed; `/relay` rejects any transaction whose program is not `gap_cover`, whose market is not sandbox, whose instruction is not `buy`, `claim` or `refund`, or with more than 3 instructions or 400_000 compute units.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. `build-gaps.mjs` builds the last 104 weekends from free daily data as Friday close to Monday open, and the CSV header and README label them as that proxy, not the exact 15:59:30 and 09:31:30 marks. Use Pyth Pro history instead if the token covers it.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Price, sign and relay quotes; run sandbox markets"`.

### Task 12: Public service deployment

**Files:** Create `service/Dockerfile`, `service/fly.toml` (or the chosen host's config), `docs/deploy-service.md`.

- [ ] **Step 1:** Deploy the service to a host that keeps a long-running WebSocket process (Fly.io, Railway or Render); not Vercel functions. Secrets `PYTH_PRO_TOKEN`, dealer key and demo-authority key as host secrets only; HTTPS; CORS restricted to the app's origin.
- [ ] **Step 2:** Verify from a clean machine: `GET /quote` returns a 96-byte signed quote; `GET /archive/...` responds; `/relay` rejects a non-sandbox transaction.
- [ ] **Step 3:** Commit: `git commit -m "Deploy the dealer service"`.

### Task 13: Web app

**Files:** Create `app/` (Vite React): `src/App.tsx`, `src/components/{Calculator,BuyPanel,LockedView,ProofScreen,Sandbox}.tsx`, `src/lib/program.ts`; tests `app/src/__tests__/{calculator,states,copy}.test.tsx`. `VITE_SERVICE_URL` = Task 12's URL.

- [ ] **Step 1:** Write failing tests: $5,000 holding suggests 200 contracts; net loss at a 2% fall equals $100 - $50 + premium; every market state, including none, renders a state card and "Try the sandbox" (Review Focus 1); USDC below total premium shows "Not enough USDC" and requests no signature (Review Focus 4); no rendered text in any state matches `/\bopen\b/i`.
- [ ] **Step 2:** `cd app && npx vitest run`; expect FAIL.
- [ ] **Step 3:** Implement; quotes refresh at 60 s; the sandbox shows "Ring the Monday bell" after a buy; the proof screen shows signed price, session, both timestamps, publishers, confidence and escrow at finalisation.
- [ ] **Step 4:** Run; expect PASS; deploy to Vercel and run one sandbox gap cycle and one multiplier-void cycle in a browser with a fresh wallet.
- [ ] **Step 5:** Commit: `git commit -m "Add the web app"`.

### Task 14: Real weekend, README and submission material

**Files:** Create `README.md`, `docs/runbook-weekend.md`.

- [ ] **Step 1:** Runbook: create the market by 11:59:30 ET Friday 27 November 2026 (an hour before the 12:59:30 early-close target), keeper running, buy one position, confirm Monday 30 November finalisation, claim. Optional rehearsal 20 to 23 November.
- [ ] **Step 2:** Run it; save every transaction link. Submit one archived update from about 45 minutes before the Friday target and one tampered update, and save both failed transactions.
- [ ] **Step 3:** README: §1 product wording and the Roster sentence; §5 archive disclosure; §7 "program checks signatures, not price fairness"; backtest table (20 weekends, payout for 200 contracts, premium, labelled as the Friday-close-to-Monday-open proxy); the recorded rejections; the real weekend's links, or the §12 fallback if it failed.
- [ ] **Step 4:** Grep README, app source and video script for `\bopen\b`, "holders only" and "liquidation insurance"; expect no matches.
- [ ] **Step 5:** Commit: `git commit -m "Document the real weekend settlement and the product"`.
