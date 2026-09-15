# Discard risk and spending review — v1.26

Source: `catan-copilot-gamelogs-1789413230434.json`, the latest local export found,
containing 24 games through September 14, 2026. The last five games recorded six
of our discards totaling 36 cards. The six preceding end-turn snapshots and dice
events are retained in `src/extension/__fixtures__/latest-games/discard-holds.json`.
No live driver or newer local capture was available during this review.

## Replay findings

These are single-decision replays, not counterfactual games. All six snapshots
record our hand as exact; three record an opponent as repairing. Replay preserves
that uncertainty. The capture does not contain execution funding state or all
legal-action signals, so the replay assumes a normal post-roll spending decision.

| UTC game finish | Decision | Hand size | Before this change | v1.26 |
| --- | ---: | ---: | --- | --- |
| 17:46 | 60 | 9 | Save for settlement | Save; no executable spending candidate |
| 18:00 | 51 | 10 | Save for settlement | Save; evaluated spending does not beat saving |
| 18:00 | 100 | 9 | Save for settlement | Buy development card, retaining the settlement plan |
| 18:17 | 18 | 11 | Build road toward settlement | Build road toward settlement |
| 18:17 | 52 | 12 | Save for settlement | Save; dev requires a costly conversion and delays construction |
| 19:09 | 79 | 21 | Trade wood for ore toward city | Trade wood for ore toward city |

The historical games ended their turns in all six cases. Current main already
corrected two, including the 21-card hold preceding a 10-card discard. The old
“~0.0 turns” descriptions do not recur in the remaining replayed holds: current
affordability requires whole bank exchanges rather than fractional trade credit.

Decision 100 is the new historical regression: buying a development card reduces
our hand from nine to six. Estimated discarded cards before the next spending
opportunity fall from about 0.55 to zero, while the settlement remains about one
own turn away. The old comparison missed this because the current hand was at
the discard limit and because it compared the development card with the entire
settlement reward, rather than retaining the later settlement's value.

## Model changes and limits

- Expected discard loss includes per-number production, repeat discards, custom
  limits, and the existing balanced-dice refill assumption. It sums losses along
  dice branches through the next spending opportunity, including our next roll.
- Board income accounts for cities and the currently blocked hex; learned income
  is the fallback when no board is available. Future robber moves, steals, and
  resource-bank shortages are not forecast.
- A development purchase retains the later productive target's value, recalculated
  using the post-purchase resources and the same race horizon. Delayed construction
  loses production value. Conversion costs remain charged at four cards per point.
- Each confirmed action is evaluated afresh. Tests cover multiple development
  purchases that each leave the hand above the limit, as well as a productive
  investment worth saving for despite high risk. This remains a heuristic,
  not a calibrated win-probability model.
- Decision logs now expose the saving score, expected losses, remaining hand size,
  purchase and continuation values, construction delay, conversion cost, and choice.

## Controls and timing

“Continue autoplaying games” is independently saved and defaults off. “Play my
turns” can stay on while results remain untouched after the current game. The
standalone runner checks the saved continuation choice before restarting for or
requesting another game; an unset legacy preference permits its explicitly
requested first game, and extension initialization writes the default off.

Bank trades and forced discards sample a 0–2 second delay. A scheduled wake-up
avoids rounding the delay to the normal 1.5-second poll. Decisions are recomputed
at wake-up, and confirmation timeouts start only after sending the action.

## Validation commands

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run check
npm run build
NODE_OPTIONS=--no-experimental-webstorage node scripts/smoke.mjs
```

The Node option keeps Node 25's built-in storage from shadowing jsdom's browser
storage during tests; it does not change the extension's browser behavior.
