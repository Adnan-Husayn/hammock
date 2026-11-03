# Product shell (agreed 3 Nov 2026)

Adds to docs/design-direction.md; every rule there still holds. Goal: the app should feel like a product a holder owns and returns to, not a calculator page.

## The cover card is the product

A position record, not a ticket costume. No barcode, no flip, no collectible styling. Every field is a fact:
- Stock and holding ("Demo holding: $5,000 NVDAx" before a wallet; "Your holding" after)
- Contracts, premium, payout cap
- Friday mark (price, date and time ET), Monday mark time ET
- Status, one of: Cover active / Monday mark final / Expired, no payout / Claimed / Voided. Never "waiting", "measuring" or "paid".
- One line answering "What happens now?"
- The exact payoff line (1% and 5% kinks intact) sits on the card.
- After purchase: "Sized for $5,000 at purchase; your token balance may differ."

## Numbers

- Hero number is net loss, always beside the loss without cover (-$73.91 vs -$150.00).
- The one-line sum stays visible: stock -$150.00 + payout +$100.00 - premium $23.91 = net -$73.91.
- Proof sits one tap away ("See the proof"), blue only when verified.

## Flow

1. Landing: "Demo holding: $5,000 NVDAx". "Stock market closed for 65h 30m. Token still trades." Primary: "Run a demo weekend". Secondary: "See how cover works". No form.
2. Buying is two steps: "Choose cover" (stock, holding, contracts) then "Review & confirm" (premium, cap, band, Monday mark time, outcome at 0%, 3% and 8% falls, quote expiry). Then the card appears as Cover active.
3. Demo runs are labelled "Demo time, compressed".
4. Settlement changes the same card in place: same header, the middle becomes Monday mark final, fall, payout, premium, net loss, without cover. A blue verified marker lands on the line at the measured fall. One primary button: "Claim $100.00 USDC". No celebration, confetti or flip.
5. Weekend token price may show on the card as a separate faint marker: "Weekend NVDAx, estimate. Does not decide the payout." Never "payout accrues".

## Ledger (only once a cover exists)

Active first, then Past (Claimed / Expired, no payout / Voided). Totals: premiums paid, payouts claimed, net, with demo and real kept separate. "Next Friday mark: <date>", "Buy by: <time ET>", "Cover next weekend" (fresh quote). No points, streaks or badges.

## Sharing

No social share. "Export receipt" only, always with premium, net loss and demo label.
