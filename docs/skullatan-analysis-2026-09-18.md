# Skullatan loss: development-card timing, city funding, and road competition

Source: the last game in `catan-copilot-gamelogs-1789763299713.json`, saved
2026-09-18T20:25:17.946Z, v1.29 discard-spending, Lais9888 vs Skullatan.
147 moves and 101 decisions. The retained regression fixture contains six original
decision snapshots, board geometry, and dice events; `sourceDecision` is the original
zero-based index. The export records the winner but marks telemetry `complete: false`.
These are decision replays, not a counterfactual claim about winning the game.

## Year of Plenty

Decision 92 held wood 2, brick 1, sheep 2, wheat 0, ore 0. The bot took **wood + ore**
with the explanation “accelerates city,” then ended the turn without a purchase.
It merely compared estimated waiting times. It neither required immediate funding
nor committed to the advertised build. Enum order broke resource ties in favor of
wood. That is a reproducible timing bug.

v1.30 requires a fully fundable, executable construction or road-award sequence in
this turn and retains its funding target. It evaluates all available constructions,
not only the previously top-ranked one. It holds the card if nothing productive can
be completed, and does not spend it to buy another development card. Equivalent
funding choices use a fixed production valuation and prefer fewer conversions;
remaining cards are valued against shortages. The city control takes **two ore**
and then builds the city, rather than taking surplus wood/sheep to trade for ore.

The final timing correction retains the card in the full historical position.
A synthetic near-victory control verifies that Year of Plenty can still fund a
road-award transfer when its two points complete the 15-point plan.

## Road Building and 3/4/11

At decision 55 we had a three-road chain, the opponent held Longest Road at five,
and our hand was wood 2, brick 1, sheep 1, wheat 0. The bot used Road Building toward
the 8-sheep wheat port (vertex 5).

The two-road route to the 3/4/11 wood/sheep intersection (vertex 33, edges 47,43)
would make our chain **five**, a tie retained by the opponent. It would not itself
remove their award. We also lacked wheat for an immediate settlement there.
Building at 33 would deny their adjacent, already connected 3/4/11 settlement site
at vertex 32; the opponent later built there. The old evaluation ignored that denial.

There was an immediately executable alternative: **Road Building for edges 47,43,
then pay one wood and one brick for edge 39**. That makes a continuous six-road chain
and transfers the award. This proves legality, not a faster or more likely 15-point
victory. It spends resources and the free-road card, can be overtaken, and competes
with productive construction.

The initial v1.30 change overvalued this temporary transfer as a four-point swing.
**v1.31 corrects that overreach:** dedicated road spending must meet the existing
victory-plan deadline or stop an imminent opponent finish. Settlement routes still
receive credit for production and denying a connected settlement opportunity, compared
with the opponent's next best alternative. Incidental road-bonus points remain in the
actual VP calculation but receive no early acquisition reward until needed by the
winning plan; a construction that immediately wins still gets full credit.

Tests now reject dedicated bonus chasing in the original early position and execute
the three-road sequence in a clearly labeled synthetic position two points from 15.
Largest Army's deadline-based timing remains unchanged. This conservative policy does
not model the full long-term probability of retaining a contested award; there is no
win-rate evidence that the early transfer would improve the historical result.

## Cities and ore

Our expected ore production was only **1/18 per own turn**, versus 8/9 wheat and
4/9 each wood/brick at decision 55. Across the game we bought **nine development
cards and no cities**. At decisions 78 and 84 the raw preferred investment was a city,
but discard handling spent the next ore on another dev.

The discard comparison evaluated the complete dev purchase/trade sequence, but only
one trade toward a city. It also charged an additional conversion penalty for ore
that expected production could not supply before the race ended, although the city's
funding estimate already depended on those conversions.

v1.30 evaluates the full available reserve-trade sequence and its remaining hand.
Conversions required to fill shortages that production cannot cover within the race
are not charged twice. Optional acceleration trades still pay their conversion
penalty. Partial funding preserves the target so the received ore is not immediately
traded away. Decisions 78 and 84 now trade surplus for ore toward a city. A road-award transfer
can take priority when needed for the finish; this is not a blanket city or ore preference.

Fornero decision 87 now keeps its three ore and trades for city wheat. The older
decision 51 continues saving after the early incidental-bonus reward is deferred. Cold-seven saving, costly optional
conversions, immediate cities, and useful dev purchases retain regression coverage.

## Validation

`NODE_OPTIONS=--no-experimental-webstorage npm test`: 359 tests passed, including
10 new Skullatan regressions, two bonus-timing score regressions, and two pre-existing local replay tests under the
ignored `.context` directory. `npm run check`, `npm run build`, and
`git diff --check` passed. The rebuilt extension identifies itself as
**v1.31 victory-timing**. No new live game was played to validate win rate.
