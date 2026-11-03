# Design direction (locked 31 Oct 2026)

Plain ASCII. The public name stays "Devnet preview" until the owner reveals the product name.

## Idea

One calm instrument built on the payoff line. The line shows the holder's net loss on Monday's fall. Without cover it keeps falling. With the suggested cover it goes flat between a 1% and a 5% fall, then falls again past 5%. Dragging along that line is the thing a judge should remember.

## Look: calibrated instrument

- Warm mineral background, ink text. Not a dark dashboard, not an editorial term sheet, nothing cartoonish, no decorative gradients, glow, glass, hexagons, floating coins or 3D.
- Large, exact numerals with tabular figures aligned to the decimal point. A humanist sans for labels; a technical mono only for signed-price details.
- Colour carries meaning only, always paired with a label or number: rust for loss, muted green for the softened 1% to 5% band, blue only for verified Pyth proof.
- Uncertainty is a visible state: "estimate", "observed" and "final" each look different.

## The line

- Stays geometrically exact. It never flexes or stretches.
- First view, before touching: the suggested-cover line, the faint uncovered line behind it, the 1% and 5% band, and one headline such as "At a 3% fall: net loss $73.91" for the sample position. Labelled as a preview.
- Interaction: drag one marker along the line, with small detents at 1% and 5%, values updating continuously. Arrow keys step it. On a phone the handle is the touch target.
- Cover size is a separate control. Default is the suggested amount, so the line starts flat. Smaller cover visibly slopes inside the band, labelled "Partial cover: loss still rises inside the band, just slower."
- Never suggest that dragging changes the price, buys cover, predicts Monday, removes all loss, or protects past 5%.

## Around the line

- Two price tracks, never merged: the weekend token price is labelled as an estimate; the Pyth marks alone decide the payout. Friday mark, weekend price and Monday mark are always labelled separately.
- Replays a visitor can run on any day, in two clearly different kinds: Verified (a real settled market, signed Pyth marks, transaction links, claim) and Demo (labelled "Demo prices, not Pyth, not a settlement", no proof badge). Demos cover no payout, partial fall, the cap and a void.
- Settlement receipt: a plain answer to "why did I get this amount?": Friday mark, Monday mark, measured fall, payout arithmetic, signed proof, escrow, and the USDC transfer.
- "Test a full weekend" at the top: a judge with an empty wallet goes from landing to a claim in under 45 seconds, fees covered.
- Premium breakdown shown on the ticket before buying.

## Rules

1. One decision first: what happens to my position if the stock falls?
2. Lead with net loss after payout and premium, not the payout alone.
3. Show the band and its limits: nothing under 1%, capped at 5%, losses resume past that.
4. Never merge prices.
5. Anyone can run a full weekend before connecting a wallet, on any day.
6. Landing to claim in under 45 seconds, fees covered.
7. Say "final" only when final, and "refund" only when money returns.
8. Every visual explains cover, state, price or proof.
9. Colour always comes with a label or number.
10. One column that works on a desktop with a wallet extension and on a phone.

## Copy

Plain, direct, specific. No hype, no promise words ("guaranteed", "protected", "safe"), and the word "open" never appears in rendered text.
