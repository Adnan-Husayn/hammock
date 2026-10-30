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
and the NVDAx reference at the mark to `friday-refs.json`, then restart; the file is read at startup. Until then the
market takes no real-market quotes, and an error is logged once.

## Checks after deploying

- `GET /quote` for a market in `FridayFinal` returns a 96-byte signed quote.
- `GET /archive/<market>/friday` responds.
- `POST /relay` refuses a transaction that does not touch a sandbox market.
- `GET /health` shows frames from all three endpoints.
- A browser request to `/quote` from another origin is blocked, and one from the app works.
