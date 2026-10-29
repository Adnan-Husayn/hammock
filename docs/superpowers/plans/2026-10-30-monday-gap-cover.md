# Monday Gap Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A devnet Solana program, dealer service and web app that sell fully collateralised one-weekend NVDA gap cover and settle it from signed Pyth Pro prices.

**Architecture:** An Anchor program holds all money and enforces every settlement and quote rule on-chain. One Node service streams Pyth, prices and signs quotes, runs the keeper and the sandbox demo authority. A React app is the only user surface.

**Tech Stack:** Rust + Anchor 0.30.1 (installed), `pyth-lazer-solana-contract` 0.11 for the verifier CPI, TypeScript + Node 25, `solana-bankrun` 0.4 / `anchor-bankrun` 0.5 + vitest for program tests, `ws` + Jupiter lite-api in the service, React + Vite for the app.

**Spec:** `docs/superpowers/specs/2026-10-30-monday-gap-cover-design.md` (v3.1). Section numbers below (§) refer to it.

## Global Constraints

- Program feed id 1314, exponent -5, band 100 to 500 bps, eligibility half-window 5 s, submission window 7 min (sandbox 5 s), bounty 100_000 per leg, quote lifetime 90 s, claim deadline 30 days (§6).
- All program arithmetic is checked i128; intermediates may be negative; overflow or a negative transfer fails (§9).
- Confidence check is `confidence * 10_000 <= price * conf_cap_bps`, never a division (§5).
- Ed25519 instruction at transaction index 0, program instruction at index 1, for both `submit_report` and `buy` (§5, §10).
- `buy` takes no amount arguments; contracts and premium come only from the signed quote (§7).
- No user-facing text contains the word "open" for the settlement; names are "Friday afternoon mark" and "Monday morning mark" (§2).
- Devnet only; no mainnet deployment; the Pyth Pro key and dealer keys never reach the browser (§11).
- Commits carry no AI attribution trailers (owner's standing preference for public repos).
- Repository layout: `programs/gap_cover/` (Rust), `tests/` (bankrun), `service/` (Node), `app/` (React), `scripts/` (deploy and one-off tools), `fixtures/` (signed Pyth payloads).

## Review Focus

1. A judge opens the app when no real market is buying (weekday, or after Sunday 17:50 ET): the app must still show the market state and offer the sandbox, never a blank or error screen. Test in Task 11.
2. The same buyer requests quotes from two tabs: both quotes carry the same nonce, the first buy succeeds and the second fails cleanly with "quote already used", never a double charge. Test in Task 6.
3. Pyth delivers duplicate or out-of-order updates across the three endpoints: the archive stores each payload once and the keeper still submits the closest one. Test in Task 8.
4. A buyer's wallet lacks enough USDC for the premium: the app says so before asking for a signature. Test in Task 11.
5. A Monday mark exactly at a band edge (gap of exactly 100 or 500 bps, or 1 bp beyond): payout is exactly 0 or exactly 1_000_000, and escrow never goes short through rounding. Test in Task 2.

---

### Task 0: Mark-time measurement logger (start first; it needs five weekdays)

**Files:**
- Create: `scripts/measure-marks.mjs`, `scripts/README-measure.md`
- Uses `PYTH_PRO_TOKEN` from `.env` (never committed; `.gitignore` already covers `.env*`)

**Interfaces:**
- Produces: `data/marks.csv` with columns `date,leg,target_utc,updates,session,conf_bps_p50,conf_bps_p95,conf_bps_max,publishers_min,publishers_p50,fresh_share`

- [ ] **Step 1:** Write `measure-marks.mjs`: connect to feed 1314 (properties `price, exponent, confidence, publisherCount, marketSession, feedUpdateTimestamp`, `fixed_rate@200ms`, JSON delivery) from T - 30 s to T + 30 s for T = 15:59:30 ET and 09:31:30 ET of the current day, and append one row per leg. Reuse the subscription shape from `../gapcover-spike/smoke2.mjs`.
- [ ] **Step 2:** Run once by hand against the next mark and check a row appears with `session` = `regular` and `fresh_share` = 1.
- [ ] **Step 3:** Schedule it on weekdays at 09:30 and 15:58 ET (launchd plist in `scripts/`, documented in `README-measure.md`).
- [ ] **Step 4:** Commit: `git commit -m "Log Pyth confidence and publishers at both mark times"`.
- [ ] **Step 5 (after five weekdays):** Set `conf_cap_bps` per leg to the larger of the provisional value (§13: Friday 10, Monday 20) and 1.5 x the observed max at that leg, and `min_publishers` to 10 unless any observed minimum is below 15, in which case use half of that minimum. Record the chosen values in `scripts/README-measure.md` and in `service/src/config.ts` (Task 8).

### Task 1: Anchor workspace and bankrun harness with the real Lazer verifier

**Files:**
- Create: `Anchor.toml`, `Cargo.toml`, `programs/gap_cover/Cargo.toml`, `programs/gap_cover/src/lib.rs`, `tests/harness.ts`, `tests/harness.test.ts`, `package.json`, `vitest.config.ts`
- Create: `fixtures/lazer/pytd2.so`, `fixtures/lazer/storage.json`, `fixtures/pyth/regular-2026-10-29.json` (copy of `../gapcover-spike/sample-regular.json`), `fixtures/pyth/premarket-2026-10-29.json`
- Create: `scripts/dump-lazer.sh`

**Interfaces:**
- Produces: `startHarness(): Promise<{ context, provider, program, payer, usdcMint, clock }>` loading `gap_cover`, the Lazer program `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` and its storage account `3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL` from fixtures; `warpTo(context, unixSeconds)`; `fixturePayload(name): Buffer` returning the 158-byte signed Solana payload.

- [ ] **Step 1:** `scripts/dump-lazer.sh` runs `solana program dump -u devnet pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt fixtures/lazer/pytd2.so` and `solana account -u devnet --output json 3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL > fixtures/lazer/storage.json`, plus the treasury account. Run it.
- [ ] **Step 2:** Write `tests/harness.test.ts::verifies a genuine fixture through the Lazer program` sending `[createEd25519Instruction(payload, 1, 12), verify_message]` directly (as in `../gapcover-spike/verify.mjs`) and expecting success; and `::rejects a tampered fixture` expecting failure.
- [ ] **Step 3:** Run `npx vitest run tests/harness.test.ts`; expect FAIL (harness missing).
- [ ] **Step 4:** Implement `startHarness` and `warpTo`. Add `pyth-lazer-solana-contract = { version = "0.11", features = ["no-entrypoint", "cpi"] }`. If it will not compile against Anchor 0.30.1, upgrade the workspace to the Anchor version that crate requires and note it in `Anchor.toml`; do not fork the crate.
- [ ] **Step 5:** Run the test; expect PASS.
- [ ] **Step 6:** Commit: `git commit -m "Set up Anchor workspace and bankrun harness with Pyth's Lazer verifier"`.

### Task 2: Pure settlement maths

**Files:**
- Create: `programs/gap_cover/src/math.rs` (unit tests in the same file)

**Interfaces:**
- Produces:
  - `pub fn gap_bps(friday: i64, monday: i64) -> Result<i128>` (signed; negative on a rise)
  - `pub fn payout_per_contract(gap_bps: i128, lower_bps: u16, upper_bps: u16) -> u64` (in USDC base units, 0..=1_000_000, rounded down)
  - `pub fn conf_ok(confidence: u64, price: i64, cap_bps: u16) -> bool`
  - `pub fn rank_key(feed_ts_us: i64, target_us: i64, payload_hash: [u8; 32]) -> (u64, i64, [u8; 32])` (lower wins)
  - `pub fn effective_multiplier_bits(multiplier: f64, new_multiplier: f64, effective_ts: i64, at: i64) -> u64`

- [ ] **Step 1:** Write failing tests:

```rust
#[test] fn payout_band() {
    assert_eq!(payout_per_contract(gap_bps(10_000, 9_950).unwrap(), 100, 500), 0);       // 0.5%
    assert_eq!(payout_per_contract(100, 100, 500), 0);
    assert_eq!(payout_per_contract(101, 100, 500), 2_500);
    assert_eq!(payout_per_contract(200, 100, 500), 250_000);
    assert_eq!(payout_per_contract(500, 100, 500), 1_000_000);
    assert_eq!(payout_per_contract(1_000, 100, 500), 1_000_000);
    assert_eq!(payout_per_contract(gap_bps(10_000, 10_300).unwrap(), 100, 500), 0);      // rise
}
#[test] fn conf_cross_multiplied() {
    assert!(conf_ok(21_057, 21_430_043, 10));        // fixture, 9.8 bps
    assert!(!conf_ok(21_457, 21_430_043, 10));       // just over 10 bps
}
#[test] fn rank_prefers_closest_then_earlier_then_hash() {
    let t = 1_000_000_000;
    assert!(rank_key(t + 200_000, t, [0; 32]) < rank_key(t - 300_000, t, [0; 32])); // closer wins
    assert!(rank_key(t - 200_000, t, [9; 32]) < rank_key(t + 200_000, t, [0; 32])); // tie: earlier wins
    assert!(rank_key(t, t, [1; 32]) < rank_key(t, t, [2; 32]));                     // tie: lower hash wins
}
#[test] fn multiplier_past_change_is_not_pending() {
    assert_eq!(effective_multiplier_bits(1.0, 1.0025, 100, 200), 1.0025f64.to_bits());
    assert_eq!(effective_multiplier_bits(1.0, 1.0025, 300, 200), 1.0f64.to_bits());
}
```

- [ ] **Step 2:** `cargo test -p gap_cover math`; expect FAIL.
- [ ] **Step 3:** Implement. `payout_per_contract` computes `(gap - lower) * 1_000_000 / (upper - lower)` in i128 and clamps.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Add settlement maths with band-edge tests"`.

### Task 3: Pyth payload parsing and eligibility

**Files:**
- Create: `programs/gap_cover/src/pyth.rs`, `programs/gap_cover/src/sigverify.rs`

**Interfaces:**
- Consumes: `conf_ok` (Task 2).
- Produces:
  - `pub struct PriceReport { pub timestamp_us: i64, pub feed_update_ts_us: i64, pub price: i64, pub exponent: i16, pub confidence: u64, pub publishers: u16, pub session: MarketSession, pub feed_id: u32 }`
  - `pub fn parse_report(payload: &[u8], feed_id: u32) -> Result<PriceReport>`; uses `pyth-lazer-protocol`'s payload decoder, or a hand-written little-endian parser tested against the fixtures if that crate conflicts.
  - `pub fn check_eligible(r: &PriceReport, market: &Market, leg: Leg) -> Result<()>` enforcing every bullet of §5 with distinct errors: `WrongFeed, WrongSession, CarriedForward, OutsideWindow, ZeroPrice, WrongExponent, WideConfidence, TooFewPublishers`.
  - `pub fn require_ed25519_at_index0(ix_sysvar: &AccountInfo, expected_signer: Option<Pubkey>) -> Result<(Pubkey, Vec<u8>)>` returning the signer and message from instruction 0 and asserting the current instruction is index 1.

- [ ] **Step 1:** Write failing tests: `parse_report` on `fixtures/pyth/regular-2026-10-29.json` returns price 21_430_043, exponent -5, confidence 21_057, publishers 20, session Regular, `feed_update_ts_us == timestamp_us == 1_793_280_669_400_000`; on the premarket fixture returns session PreMarket. One `check_eligible` test per error variant, built by editing a parsed fixture.
- [ ] **Step 2:** Run `cargo test -p gap_cover pyth`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Parse Pyth Pro payloads and enforce report eligibility"`.

### Task 4: Market creation and `submit_report`

**Files:**
- Create: `programs/gap_cover/src/state.rs`, `programs/gap_cover/src/instructions/create_market.rs`, `programs/gap_cover/src/instructions/submit_report.rs`
- Test: `tests/create_and_report.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `Market` account with every §6 parameter plus `state: MarketState { Created, FridayFinal, MondayFinal, Voided }`, `friday: Option<Candidate>`, `monday: Option<Candidate>`, `contracts_sold: u32`, `total_premiums: u64`, `open_positions: u32`, `swept: bool`, `payout_per_contract: u64`. The NVDAx reference price `f_x` is not stored on-chain; the dealer service records it when it sees `FridayFinal` (Task 9).
  - `Candidate { price: i64, feed_ts_us: i64, payload_hash: [u8; 32], submitter: Pubkey }`
  - `create_market(params: MarketParams)`, PDA seeds `["market", dealer, friday_target_ts.to_le_bytes()]`; reserves are token accounts with PDA authority `["vault", market]`
  - `submit_report(leg: Leg, payload: Vec<u8>)` for real markets (CPI to `pyth_lazer_solana_contract::cpi::verify_message` with `ed25519_instruction_index = 0`); `submit_sandbox_price(leg: Leg, price: i64)` for sandbox markets, signer must be `demo_authority`
- [ ] **Step 1:** Write failing tests: create a market whose Monday target is 1_793_280_672 (3 s after the fixture) and assert both reserves hold `max_contracts * 1_000_000` and `200_000`; submit the regular fixture as the Monday report after warping to the target and assert it becomes the candidate with the submitter stored; submit with the Ed25519 instruction at index 1 and assert `WrongInstructionLayout`; submit after T + 7 min and assert `WindowClosed`; on a sandbox market assert `submit_report` is rejected and `submit_sandbox_price` by a non-authority is rejected; on a real market assert `submit_sandbox_price` is rejected; on a sandbox market created at time C assert the Friday target is C + 5, buying close C + 45, Monday target C + 60, and the submission window 5 s, all enforced by the program.
- [ ] **Step 2:** `npx vitest run tests/create_and_report.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement. `create_market` rejects targets less than 3_600 s ahead on real markets. Replacement uses `rank_key`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Create markets and accept verified Pyth reports"`.

### Task 5: `finalise_friday`, `finalise_monday` and void rules

**Files:**
- Create: `programs/gap_cover/src/instructions/finalise.rs`
- Test: `tests/finalise.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces: `finalise_friday()` and `finalise_monday()` (signer anyone); both read the NVDAx mint's Token-2022 `ScaledUiAmountConfig` and apply §8.
- [ ] **Step 1:** Write failing tests: Friday with candidate moves to `FridayFinal` and pays 100_000 to the stored submitter; Friday without candidate moves to `Voided`; Monday at a 2% fall sets `payout_per_contract = 250_000` and leaves `contracts_sold * 250_000` in escrow; Monday at a rise sets 0 and does not fail; multiplier changed after creation voids at either finalisation; a change scheduled before the Monday target voids; a past effective timestamp equal to the creation-time value does not void; finalise before the window ends fails with `WindowOpen`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the §9 distributions for `MondayFinal` and `Voided`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Finalise each mark and apply void rules"`.

### Task 6: `buy` with dealer-signed quotes

**Files:**
- Create: `programs/gap_cover/src/instructions/buy.rs`, `programs/gap_cover/src/quote.rs`
- Test: `tests/buy.test.ts`

**Interfaces:**
- Produces:
  - Quote message, 92 bytes little-endian: `b"MGCQ"` | market (32) | buyer (32) | contracts u32 | premium_per_contract u64 | expiry i64 | nonce u64
  - `pub fn decode_quote(msg: &[u8]) -> Result<Quote>`; TypeScript twin `encodeQuote(q): Buffer` in `service/src/quote.ts` (Task 9)
  - `buy()` with no arguments; `Position` PDA seeds `["position", market, buyer]` with `contracts, premium_paid, last_nonce, closed`
- [ ] **Step 1:** Write failing tests: a valid quote moves `total_premium` from buyer and `contracts * 1_000_000 - total_premium` from the reserve, so escrow equals `contracts_sold * 1_000_000`; `open_positions` increments only on the first buy; rejects: signer not the dealer key, buyer mismatch, expired by clock, `nonce != last_nonce + 1`, premium 0, premium 1_000_000, capacity exceeded, before `FridayFinal`, after buying close, Ed25519 instruction not at index 0. Review Focus 2: two quotes with the same nonce, first buy succeeds, second fails with `QuoteUsed`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Sell cover against dealer-signed quotes"`.

### Task 7: `claim`, `refund`, `sweep`, `close_market`

**Files:**
- Create: `programs/gap_cover/src/instructions/settle_out.rs`
- Test: `tests/settle_out.test.ts`

**Interfaces:**
- Produces: `claim()`, `refund()`, `sweep()`, `close_market()` per §9 and §10; destination token account must be owned by the position owner.
- [ ] **Step 1:** Write failing tests: claim pays `contracts * payout_per_contract` and closes the position; a zero-payout claim closes the position; claim twice fails; claim to someone else's token account fails; refund pays `premium_paid` only in `Voided`; refund still works 60 days later; sweep fails before 30 days and succeeds after in `MondayFinal`; sweep fails in `Voided`; close fails with open positions and succeeds when `open_positions == 0`, when swept, or when voided with no sales.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Add `tests/settle_out.test.ts::idl has no transfer instruction` asserting the IDL's instruction names are exactly `create_market, submit_report, submit_sandbox_price, finalise_friday, finalise_monday, buy, claim, refund, sweep, close_market`. Run full suite `npx vitest run && cargo test -p gap_cover`; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Pay out claims and refunds; sweep and close markets"`.

### Task 8: Dealer service, Pyth side

**Files:**
- Create: `service/package.json`, `service/src/config.ts`, `service/src/pyth.ts`, `service/src/archive.ts`, `service/src/keeper.ts`
- Test: `service/test/archive.test.ts`, `service/test/keeper.test.ts`

**Interfaces:**
- Produces:
  - `streamNvda(onUpdate: (u: SignedUpdate) => void): () => void` over all three endpoints, `SignedUpdate = { payloadHex: string, feedTsUs: bigint, timestampUs: bigint, price: bigint, confidence: bigint, publishers: number, session: string, hash: string }`
  - `Archive.add(u)` (dedup by `hash`), `Archive.window(targetUs: bigint): SignedUpdate[]` (T ± 5 s), served at `GET /archive/:market/:leg`
  - `Keeper.run(market)`: at T + 2 s submits the closest eligible update; until T + 7 min resubmits whenever the archive has a strictly closer one than the on-chain candidate; then calls the right finalise.
- [ ] **Step 1:** Write failing tests: duplicates by hash stored once; out-of-order arrival still yields the closest by `(|feedTs - T|, feedTs, hash)`; updates with `session != regular` or `feedTs != timestampUs` excluded from the window. Review Focus 3.
- [ ] **Step 2:** `cd service && npx vitest run`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Stream, archive and submit Pyth reports from the dealer service"`.

### Task 9: Dealer service, pricing, quotes, sandbox and fee payer

**Files:**
- Create: `service/src/jupiter.ts`, `service/src/pricing.ts`, `service/src/quote.ts`, `service/src/sandbox.ts`, `service/src/relay.ts`, `service/src/server.ts`, `service/data/nvda-gaps.csv`
- Test: `service/test/pricing.test.ts`, `service/test/quote.test.ts`

**Interfaces:**
- Produces:
  - `nvdaxReference(): Promise<{ price: number, roundTripBps: number, multiplier: number, decimals: number } | null>` (§7 formulas; null when Jupiter has no route)
  - `premiumPerContract({ gaps: number[], m: number, sold: number, max: number }): number | null` (null at or above 0.95)
  - `Freeze.update(ref, nowMs)` and `Freeze.isFrozen(nowMs)` (5% in 30 min, round trip over 100 bps, or no route; auto-resume after 15 min clean)
  - `signQuote(q: Quote, dealerKey): { message: Buffer, signature: Buffer }`, `encodeQuote(q): Buffer` matching Task 6's 92-byte layout
  - HTTP: `GET /quote?market&buyer&contracts`, `POST /sandbox/start {mode: "gap"|"multiplier_void"}`, `POST /relay` (fee payer, sandbox buy/claim/refund only)
- [ ] **Step 1:** Write failing tests: with all historical gaps 0 and `m = 0`, base 0 and premium 0.007; with gaps `[0.02]`, `m = 0`, sold 0 the premium is 0.25 + 0.0675 + 0.002 = 0.3195; at sold = max utilisation adds `2 * base`; premium at or above 0.95 returns null; freeze triggers on each condition and lifts after 15 clean minutes; `encodeQuote` bytes equal a fixture produced by the Rust `decode_quote` test; nonce read from `Position.last_nonce` and reused across refreshes; `sandbox.start("gap")` picks the Monday fall (0.5%, 2.5% or 6%) only after the market's buying close has passed, never before.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Build `nvda-gaps.csv` (last 104 Friday-close to Monday 09:31 gaps) with a one-off script in `scripts/` from a free daily/intraday source; record the source in the CSV header. Then calibrate: run the §7 formula over the 104 weekends and adjust the uncertainty coefficient (0.25) and reserve (0.002) only if the dealer's simulated total P&L is negative; record any change in `config.ts` and the spec's §13.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit: `git commit -m "Price, sign and relay quotes; run sandbox markets"`.

### Task 10: Test mint, faucet and devnet deployment

**Files:**
- Create: `scripts/create-test-mint.ts`, `scripts/deploy-devnet.sh`, `scripts/create-weekend-market.ts`
- Test: `tests/test-mint.test.ts`

**Interfaces:**
- Produces: a Token-2022 mint "NVDAx (test)" with 8 decimals and the `ScaledUiAmount` extension, mint and multiplier authority held by the dealer service; `faucet(wallet)` endpoint in `server.ts` giving 100 test NVDAx and 1,000 demo USDC once per wallet; `create-weekend-market.ts` reads Pyth's schedule for feed 1314 from `https://pyth.dourolabs.app/v1/symbols`, refuses holidays and scheduled multiplier changes, and moves the Friday target to 12:59:30 ET on early closes.
- [ ] **Step 1:** Write failing test: `scheduleTargets(date)` returns 12:59:30 ET for Friday 27 November 2026 and refuses Thursday 26 November; multiplier update on the test mint changes `effective_multiplier_bits`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; deploy the program to devnet with `anchor deploy --provider.cluster devnet`.
- [ ] **Step 4:** Run; expect PASS; confirm the program id on Solana Explorer (devnet).
- [ ] **Step 5:** Commit: `git commit -m "Add test mint, faucet and devnet deployment scripts"`.

### Task 11: Web app

**Files:**
- Create: `app/` (Vite React): `src/App.tsx`, `src/components/Calculator.tsx`, `src/components/BuyPanel.tsx`, `src/components/LockedView.tsx`, `src/components/ProofScreen.tsx`, `src/components/Sandbox.tsx`, `src/lib/program.ts`
- Test: `app/src/__tests__/calculator.test.tsx`, `app/src/__tests__/states.test.tsx`

**Interfaces:**
- Consumes: service HTTP endpoints (Task 9), program IDL (Tasks 4 to 7).
- [ ] **Step 1:** Write failing tests: calculator for a $5,000 holding suggests 200 contracts and shows net loss at 2% fall = $100 - $50 + premium; app renders a state card and a "Try the sandbox" button in every market state including no market (Review Focus 1); buy button shows "Not enough USDC" and requests no signature when balance < total premium (Review Focus 4); no rendered text matches `/\bopen\b/i` near "Monday" or "Friday" (copy rule).
- [ ] **Step 2:** `cd app && npx vitest run`; expect FAIL.
- [ ] **Step 3:** Implement. Quotes auto-refresh at 60 s. The proof screen shows signed price, session, both timestamps, publishers, confidence and escrow at finalisation.
- [ ] **Step 4:** Run; expect PASS; deploy to Vercel as a preview and run one sandbox gap cycle end to end in a browser.
- [ ] **Step 5:** Commit: `git commit -m "Add the web app: calculator, buy, locked view, proof and sandbox"`.

### Task 12: Real weekend, README and submission material

**Files:**
- Create: `README.md`, `docs/runbook-weekend.md`
- Modify: `service/src/config.ts` (final caps from Task 0)

- [ ] **Step 1:** Write `runbook-weekend.md`: create market Friday 27 November 2026 by 11:59:30 ET (an hour before the 12:59:30 early-close target), keeper running, buy one position from a test wallet, confirm Monday 30 November finalisation, claim. If ready earlier, also run 20 to 23 November.
- [ ] **Step 2:** Run the weekend; save every transaction link. On devnet, also send one 45-minute-old fixture and one tampered fixture to `submit_report` and save both failed transaction signatures.
- [ ] **Step 3:** Write `README.md`: product in the §1 wording, the Roster distinction sentence, the challenge-archive disclosure (§5), "program checks signatures, not price fairness" (§7), the backtest table (last 20 weekends, payout for 200 contracts, premium from §7), the recorded old-payload and tampered-payload rejections, and the real weekend's transaction links. Fallback per §12 if the weekend failed.
- [ ] **Step 4:** Grep the README, app and video script for `open` near "Monday"/"Friday" and for "holders only", "liquidation insurance"; expect no matches.
- [ ] **Step 5:** Commit: `git commit -m "Document the real weekend settlement and the product"`.
