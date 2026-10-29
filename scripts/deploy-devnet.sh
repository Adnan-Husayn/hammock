#!/usr/bin/env bash
# Deploy gap_cover to devnet. Never commits keypairs: the program keypair is backed up to keys/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

SO=target/deploy/gap_cover.so
KP=target/deploy/gap_cover-keypair.json
PAYER="${PAYER_KEYPAIR:-$HOME/.config/solana/id.json}"
RPC="${RPC_URL:-https://api.devnet.solana.com}"

[ -f "$SO" ] || { echo "missing $SO: run npm run build"; exit 1; }
[ -f "$KP" ] || { echo "missing $KP"; exit 1; }

mkdir -p keys
[ -f keys/gap_cover-keypair.json ] || cp "$KP" keys/gap_cover-keypair.json
chmod 600 keys/gap_cover-keypair.json

# Size the program account close to the binary (+10% headroom, 16-byte aligned) to save rent.
SIZE=$(wc -c < "$SO" | tr -d ' ')
MAX_LEN=$(( (SIZE * 11 / 10 + 15) / 16 * 16 ))
echo "so=$SIZE bytes, max-len=$MAX_LEN"

solana program deploy "$SO" \
  --url "$RPC" \
  --keypair "$PAYER" \
  --program-id "$KP" \
  --max-len "$MAX_LEN"

echo "Program id: $(solana-keygen pubkey "$KP")"
