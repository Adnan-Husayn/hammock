# Deploying the dealer service

The service is one long-running process. It holds three WebSocket connections to Pyth and runs a keeper loop, so it
needs a host that keeps a container running; request-scoped functions will not work. Run exactly one instance: a
second would submit the same reports and spend fees twice, and would keep its own logs.

## Build and run

Build from the repository root, because the build context is filtered by the root `.dockerignore`:

    docker build -f service/Dockerfile -t gap-cover-service .

The image sets `NODE_ENV=production` and starts the same command as `npm start` in `service/`. The service listens
on `SERVICE_PORT` (default 8787). Terminate HTTPS at the host or a reverse proxy in front of it.

## Secrets

Hold these in the host's secret store only. Never put them in the image, a repository file, or a build argument.

| Name | What it holds |
|---|---|
| `PYTH_PRO_TOKEN` | The Pyth Pro stream token |
| `SOLANA_RPC_URL` | RPC endpoint; treat as a secret if the URL carries a provider key |

The four keys below are env vars holding a path to a JSON keypair file. Mount each file from the secret store,
readable by the container's `node` user, on a path outside the volume described below.

| Name | What it holds |
|---|---|
| `DEALER_KEYPAIR` | Dealer key. Pays keeper reports and finalise calls, so it needs SOL, and creates missing USDC accounts for bounty recipients |
| `DEMO_AUTHORITY_KEYPAIR` | Sandbox demo authority |
| `RELAY_KEYPAIR` | Sandbox fee payer. Must be a separate key that holds only SOL |
| `QUOTE_KEYPAIR` | Optional. Quote signing key; the dealer key is used when unset |
| `FAUCET_KEYPAIR` | Optional. Pays the faucet's SOL drips. Must differ from the dealer and relay keys. When unset the faucet sends tokens only, no SOL |

The faucet's SOL drip (0.005 SOL, only to a wallet holding under 0.003 SOL, at most 0.25 SOL per hour across all
wallets) comes from `FAUCET_KEYPAIR`, never the dealer, so fresh wallets cannot drain the keeper's fee payer. The Fly
configs do not mount it yet. To enable it, generate a key that holds only a little SOL, store it as the secret
`FAUCET_KEY_B64`, and add to both `fly.toml` and `fly.real.toml` a `[[files]]` entry with
`guest_path = "/run/keys/faucet.json"` and `secret_name = "FAUCET_KEY_B64"`, plus `FAUCET_KEYPAIR =
"/run/keys/faucet.json"` under `[env]`. The per-wallet faucet cooldown is kept in `logs/faucet-cooldown.json`.

## Configuration

| Name | Required | Meaning |
|---|---|---|
| `CORS_ORIGIN` | Yes in production | The app's origin, for example `https://app.example`. The service refuses to start when `NODE_ENV=production` and this is unset or `*`. Elsewhere it defaults to `*`. `/archive` and `/health` are public and always send `*` |
| `GAP_COVER_PROGRAM_ID` | Yes, unless in the config file | Program address |
| `DEVNET_CONFIG_PATH` | Yes | Path to the JSON config with `usdcDemo.mint` and `nvdaxTest.mint`. The image contains no `config/` directory, so mount this file. Default `/app/config/devnet.json` |
| `REAL_MARKETS` | For real markets | Comma-separated market addresses. Each gets a keeper. Empty means a sandbox-only run |
| `TRUST_PROXY` | See below | `1` or `true` to read client addresses from `X-Forwarded-For` |
| `SERVICE_PORT` | No | Listen port, default 8787 |
| `ARCHIVE_PATH`, `FRIDAY_REFS_PATH`, `SANDBOX_MARKETS_PATH` | No | Override the files described below |

With `REAL_MARKETS` set, the service refuses to start without a working report stream.

## Real-market weekends

`service/fly.toml` is for sandbox-only operation: Fly stops the machine when no HTTP traffic arrives and starts it on
the next request. The outbound Pyth stream and the keeper's timers do not count as traffic, so with that config the
machine can be stopped at 15:59:30 ET Friday or 09:31:30 ET Monday, and the mark is missed.

`service/fly.real.toml` is the same config with `auto_stop_machines = "off"` and `min_machines_running = 1`. Both
files also set `AUTO_STOP_MACHINES` in `[env]` to match. When `REAL_MARKETS` is non-empty and `AUTO_STOP_MACHINES` is
anything but `off`, the service logs an `ERROR: REAL_MARKETS is set but AUTO_STOP_MACHINES=...` line at startup. Fly
does not tell a machine its own stop setting, so this env var is the only signal; keep it in step if you edit either
file.

Before Friday (at least an hour before the Friday target, once the market exists):

1. Create the market with `scripts/create-real-market.ts` and note the address it prints.
2. From the repository root:

        fly deploy -c service/fly.real.toml -e REAL_MARKETS=<market address>

3. Check `fly machine list` shows one machine `started`, and `fly logs` shows no `AUTO_STOP_MACHINES` error.
4. `GET /health` shows the market and frames from the endpoints.

After settlement (the market is `Settled` or `Voided` on chain and claims are open; claims do not need the keeper):

        fly deploy -c service/fly.toml -e REAL_MARKETS=

This returns to stop-when-idle with no real markets. An external uptime ping on `/health` from 15 minutes before each
mark is a cheap second guard.

## Alerts

Set `ALERT_WEBHOOK_URL` (optional, a Fly secret since the URL can carry a token) to get a short JSON POST when a
keeper tick fails, a market misses its Friday reference, or a stream endpoint is silent over 60 s within 10 minutes of
a mark. The body is `{"text": "...", "source": "gap-cover-service", "atMs": <ms>}`. It carries market addresses
and error text with URLs removed, never keys or tokens. Each distinct alert is sent at most once per 10 minutes, and
at most 20 alerts go out per hour. A failing webhook is logged and ignored.

## TRUST_PROXY

Per-IP limits on `/relay` use the socket address by default.

- Directly exposed: leave `TRUST_PROXY` unset.
- Behind a proxy: every request appears to come from the proxy, so all clients share one limit. Set `TRUST_PROXY=1`.
- The service uses the first `X-Forwarded-For` hop. That is only trustworthy when the proxy replaces any
  `X-Forwarded-For` the client sent. A proxy that appends leaves the client's forged value first, and the limit can
  then be dodged. Check this on your proxy, and make sure the service is reachable only through it.

## Persistent volume

Mount a persistent volume at `/app/logs`, writable by the `node` user. Without one, a restart loses:

| File | Why it matters |
|---|---|
| `archive.jsonl` | Signed reports around each mark. It backs the public archive and the keeper's next submission, and it must survive a restart between Friday and Monday |
| `sandbox-markets.json` | Sandbox markets this service started; the Monday bell refuses any others |
| `friday-refs.json` | The NVDAx reference f_x per market. Real-market quotes need it. The keeper records it only until 15 minutes after the Friday window closes. After that, or if the file is lost late, quotes stay refused until it is restored |

## Health

`GET /health` returns the age in seconds of the last frame from each Pyth endpoint and, per real market, the on-chain
state, the age of the last keeper tick and last clean tick, the count of consecutive failed ticks, and whether f_x is
recorded. `ok` is false when any keeper tick is failing, a market missed its f_x (`fridayRefMissed`), or no endpoint has sent a frame in 60 s. It always answers
200, so a passing RPC failure does not restart the process; alert on `ok` rather than on the status code.

An endpoint silent for more than 60 s within 10 minutes of a mark logs an error at error level, once per silence.
Route error-level logs to an alert, as the marks are when it matters.

If `fridayRefMissed` is true, the service was away or had no price route around the mark. Add the market's address
and the NVDAx reference at the mark to `friday-refs.json`. The keeper re-reads the file within a second and
`fridayRefMissed` clears; no restart is needed. Until then the market takes no real-market quotes, and an error is
logged once.

## Checks after deploying

- `GET /quote` for a market in `FridayFinal` returns a 96-byte signed quote.
- `GET /archive/<market>/friday` responds.
- `POST /relay` refuses a transaction that does not touch a sandbox market.
- `GET /health` shows frames from all three endpoints.
- A browser request to `/quote` from another origin is blocked, and one from the app works.
