# Hammock demo video script

Length: 3 minutes at most. The voiceover is about 430 words with the placeholders filled, which needs a steady pace of roughly 145 words a minute. Time a read-through before recording the screens, and cut the weekend-gaps or bounty sentence if it runs long. Record the voice first, then cut the screen recordings to it.

Every placeholder that depends on the 27 to 30 November weekend is written as `[FILL AFTER 30 NOV: ...]`. Do not record slots 3 and 4 before then.

## Script

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 to 0:10 | Landing page of hammock-finance.vercel.app. Headline "You hold $5,000 of NVDAx." and the line "Stock market closed for 65h 30m. Token still trades." | The US stock market shuts for 65 and a half hours every weekend. If you hold a tokenised stock like NVDAx, bad news on Saturday becomes your loss on Monday morning. |
| 0:10 to 0:32 | The cover card with the payoff line. Drag the dot slowly from 0% to 8%. Pause at 1%, 3% and 5% so the net loss reads $73.91 each time, beside the loss without cover. | I'm Adnan, and I built Hammock. Buy before the weekend. If the stock gaps down Monday, Hammock pays you in USDC. Each contract pays nothing for a fall of 1% or less, then rises in a straight line to one dollar at 5%. One contract for every 25 dollars I hold keeps my net loss flat across that band. |
| 0:32 to 0:58 | Recording from Friday 27 Nov. Status line "[FILL AFTER 30 NOV: stock]: Buying now". Press "Choose devnet cover", pick the stock and holding, go to the review step, press "Buy cover", approve in the wallet. Card changes to "Cover active". | This is a real devnet market for the weekend of 27 November. The market closed early that Friday, so the Friday afternoon mark was taken at 12:59:30 Eastern, at [FILL AFTER 30 NOV: Friday mark price]. I choose [FILL AFTER 30 NOV: contracts] contracts. The review step shows the premium, [FILL AFTER 30 NOV: premium], and my net loss at three different falls. One signature, and the card says Cover active. |
| 0:58 to 1:22 | Recording from Monday 30 Nov. The same card, now "[FILL AFTER 30 NOV: card status]", with the Monday mark, fall, payout, premium and net loss. Press "Claim [FILL AFTER 30 NOV: amount] USDC", approve, show the wallet balance change. | On Monday the keeper submitted the signed Pyth price by itself. The Monday morning mark, taken at 09:31:30 Eastern, was [FILL AFTER 30 NOV: Monday mark price], a [FILL AFTER 30 NOV: fall or rise, percent]. The same card now shows [FILL AFTER 30 NOV: payout per contract and total payout]. I press Claim, sign once, and [FILL AFTER 30 NOV: amount] USDC is in my wallet. |
| 1:22 to 1:48 | Fresh devnet wallet. "Show details", then "Run an NVDA weekend on devnet". The five-step strip advances: Demo tokens, Friday mark, Buy 200 contracts, Monday mark, Claim. Show the label "Sandbox prices, not Pyth" on the receipt. | You can run the same flow today. Connect a devnet wallet and press Run an NVDA weekend on devnet. Hammock sends demo tokens and sets a Friday mark. I buy 200 contracts with one signature, the Monday mark lands, and I claim. The relay pays every fee. The app labels these as sandbox prices. |
| 1:48 to 2:32 | Settlement receipt for the 9 Nov practice market: Friday afternoon mark $186.90, Monday morning mark $172.38, measured fall 7.77%, payout per contract $1.00, contracts sold 0. Then Solana Explorer on devnet, market account `4hq55H24...Dx7kug`, then the finalise transaction. | This market settled with nobody watching. On Friday 6 November the program recorded NVDA at 186.90. On Monday 9 November it recorded 172.38, a fall of 7.77%. That is past the 5% cap, so the program set the full payout of 1 USDC per contract and finalised 7 minutes after the Monday mark. Nobody bought cover that weekend, so no claim was paid on it. Each price is a signed Pyth Pro report from the regular session. My program verifies it through Pyth's Lazer verifier and rejects any report more than 5 seconds from the target time. Anyone can submit a closer report and earn a ten-cent bounty. |
| 2:32 to 2:54 | The stock picker switching NVDA, TSLA, SPY, AAPL. Then the "Solana devnet, demo tokens" badge. | Hammock runs on devnet with demo USDC, for NVDA, Tesla, SPY and Apple. One dealer account posts a full dollar of collateral for every contract before any sale. Five more stocks are configured and switched off until their price data checks out. |
| 2:54 to 3:00 | End card: Hammock mark, "hammock-finance.vercel.app", "Built by Adnan Husayn", "Solana devnet". | Try a weekend yourself at hammock-finance.vercel.app. |

## Notes on the placeholders

- If the 30 November mark is a rise or a fall of 1% or less, the card will say "Expired, no payout" and there is no Claim button. With four markets running, use the stock that paid. If none paid, show the zero result as it is in slot 4 and change the last sentence to say the cover expired with no payout. Slot 5 then carries the claim.
- If the real weekend does not settle cleanly, cut slots 3 and 4, stretch slot 5 to fill the time, and say in the voiceover that the buy and claim shown are on a sandbox market.
- Slot 6 says "nobody bought cover that weekend". Keep that sentence. The 9 November market recorded a payout and paid no one.
- Say "Friday afternoon mark" and "Monday morning mark" every time. Never say "the close" or use the bell's name for the Monday mark.

## Shot list

Record at 1920 x 1080, browser zoom 110%, wallet extension pinned so the approval popup is visible. Record each shot as its own file.

1. Landing page, 8 seconds still, no cursor movement. NVDA selected.
2. Payoff line drag on the cover card, 0% to 8% and back, slowly, with pauses at 1%, 3% and 5%. Two takes.
3. Friday 27 Nov, after the 12:59:30 ET mark is final: status line showing "Buying now", then the full buy on the real market. Choose cover, review step, "Buy cover", wallet approval, card at "Cover active". Capture the review step for 3 full seconds so the premium and the three outcomes are readable.
4. Friday 27 Nov: Solana Explorer page for the buy transaction.
5. Weekend, optional: the card with the faint weekend token price marker and its label "estimate. Does not decide the payout."
6. Monday 30 Nov, after about 09:39 ET: the same card settled. Then "Claim", wallet approval, the confirmation line, and the wallet's USDC balance before and after.
7. Monday 30 Nov: "See the proof" on that card. Settlement receipt with the "Verified Pyth proof" badge, signed details for both marks (session, timestamp, publishers, confidence), escrow and the USDC transfer link.
8. Monday 30 Nov: Solana Explorer page for the claim transaction.
9. Sandbox run with a fresh devnet wallet, one continuous take from "Show details" to the claimed card. Do three takes and keep the shortest.
10. Sandbox receipt showing "Sandbox prices, not Pyth".
11. Settlement receipt for the 9 Nov practice market (`4hq55H24V9VPGsXZs8cyp4jCF69g2SKTaNNw45Dx7kug`). This needs the app built with VITE_VERIFIED_MARKET set to that address, then "Replay a weekend", "Verified replay".
12. Solana Explorer, devnet, the 9 Nov market account, scrolled to show the program id `HzYCke4E...MG9g` as owner.
13. Solana Explorer, the finalise transaction for the 9 Nov Monday mark, time 14:38:32 UTC. [FILL: transaction signature, from the market account's history]
14. Stock picker, one click each on NVDA, TSLA, SPY, AAPL, 2 seconds per stock. Record this only after the web app is republished with all four stocks.
15. End card, 6 seconds still.

## Checks before publishing

- Total run time is 3:00 or less.
- The live site shows all four stocks before slot 7 goes in. If it does not, cut the stock picker shot and the list of four names from the voiceover.
- No frame shows a real-money balance, a seed phrase or a wallet on mainnet.
- Every sandbox or demo shot has its label visible on screen.
- The numbers spoken in slots 3 and 4 match the receipt on screen in shot 7.
