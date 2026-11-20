# Weekend runbook, 27 to 30 November 2026

Four real markets on devnet, created 20 November. The service runs on Fly with `service/fly.real.toml` (always on) and these four addresses in `REAL_MARKETS`.

| Stock | Market account |
|---|---|
| NVDA | `9iZUBszuV3iAQzwKCmfRqUMDKEJZ2TEJYJDRuJWM1NFf` |
| TSLA | `BJado2pmMKk5nuqnLg6PyUf2ph4NPjbe6FEkZvZxxUFi` |
| SPY | `BXBoRTPr9swiUV7hQ3kRZShPVW6sP9rC11JTZyesqwuV` |
| AAPL | `6J7iWXNBWNqivq5kUDZwV23c9fiMuYB1LtYDj1HscRiu` |

| Event | ET | UTC | IST |
|---|---|---|---|
| Friday mark (early close) | Fri 27 Nov 12:59:30 | 17:59:30 | 23:29:30 |
| Buying closes | Sun 29 Nov 17:50 | 22:50 | Mon 30 Nov 04:20 |
| Monday mark | Mon 30 Nov 09:31:30 | 14:31:30 | 20:01:30 |

## The one thing only I can do

Buy at least one contract on one of the four markets from my own devnet wallet, between the Friday mark and Sunday 17:50 ET. Without a buy, the weekend proves settlement but not a paid claim.

1. Open https://hammock-finance.vercel.app with the wallet on devnet. Pick a stock and buy cover. Keep the transaction signature.
2. After the Monday mark, if the market pays (a fall of more than 1%), press Claim and keep that signature too. If the fall is 1% or less, there is nothing to claim; the result still counts.

## Friday, after 17:59:30 UTC

    curl -s https://ambergris-moonrise-938.fly.dev/health

For each market: `state` is `FridayFinal`, `fridayRefRecorded` is `true`, `fridayRefMissed` is `false`, and `ok` is `true`. Every endpoint should show a `lastFrameAgeS` of a few seconds. The keeper usually finalises a few minutes after the target.

## Monday, after 14:31:30 UTC

Same check. Each market should reach `MondayFinal` within about ten minutes (the practice market took 7).

## Reading the results

    node scripts/read-market.ts 9iZUBszuV3iAQzwKCmfRqUMDKEJZ2TEJYJDRuJWM1NFf BJado2pmMKk5nuqnLg6PyUf2ph4NPjbe6FEkZvZxxUFi BXBoRTPr9swiUV7hQ3kRZShPVW6sP9rC11JTZyesqwuV 6J7iWXNBWNqivq5kUDZwV23c9fiMuYB1LtYDj1HscRiu

It decodes each market account with Anchor's `BorshAccountsCoder` and `idl/gap_cover.json`. Prices are i64 with exponent -5, so `18689659` is $186.89659. It prints the state, both marks, the gap, payout per contract, contracts sold, premiums and the settle time.

## What goes into docs/submission.md

The five `[FILL AFTER 30 NOV]` lines:

1. The four stocks and the addresses above.
2. Friday and Monday price per stock, from `read-market.ts`.
3. Gap per stock and `payoutPerContractUsdc`.
4. Contracts bought, premium paid, amount claimed, and Explorer links (`https://explorer.solana.com/tx/<sig>?cluster=devnet`) for my buy and claim.
5. `settledAt` minus 14:31:30 UTC per market, and "nobody touched it" unless I had to step in.

Also update the first screen's verified replay to one of these markets if it settles cleanly: rebuild the app with `VITE_VERIFIED_MARKET=<address>` and publish.

## If a market misses a mark

- Friday missed (`state` still `Created` well after 18:15 UTC, or `fridayRefMissed` true): check `fly logs -a ambergris-moonrise-938` and `fly machine list`; start the machine if it stopped. A market that never gets a Friday mark sells nothing and that is all; buy on another stock. If only `fridayRefMissed` is true while the state is `FridayFinal`, add the market and its token reference to `friday-refs.json` on the volume (docs/deploy-service.md, "Health").
- Monday missed: anyone can submit a report from the archive while the submission window is open, so restart the machine first. If no valid Monday report lands, `finalise_monday` voids the market and buyers take their premium back as a refund. Report it as a void in the submission; it shows the refund path works.
- Whole service down: `fly deploy -c service/fly.real.toml -e REAL_MARKETS=<the four addresses>`, then `fly machine start` if the machine stays stopped.

## After settlement

Once all four are `MondayFinal` (or voided) and any claim is done:

    fly deploy -c service/fly.toml -e REAL_MARKETS=

That returns the service to stop-when-idle. Claims do not need the keeper.
