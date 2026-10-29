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
