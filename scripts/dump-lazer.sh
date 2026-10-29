#!/usr/bin/env bash
# Dump Pyth's Lazer verifier program, its storage account and the treasury from devnet.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${SOLANA_URL:-https://api.devnet.solana.com}"
OUT=fixtures/lazer
mkdir -p "$OUT"
solana program dump -u "$URL" pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt "$OUT/pytd2.so"
solana account -u "$URL" 3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL --output json -o "$OUT/storage.json"
solana account -u "$URL" opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7 --output json -o "$OUT/treasury.json"
# Token-2022 with ScaledUiAmount (loaded over litesvm's bundled copy so the harness matches devnet)
solana program dump -u "$URL" TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb fixtures/token2022.so
ls -l "$OUT"
