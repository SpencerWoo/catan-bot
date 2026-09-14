# Exact hands and the remaining game

## v1.21: time bonuses for victory

Largest Army and Longest Road remain in completion forecasts, but no longer
automatically earn an early action reward. Bonus-only investment becomes useful
when it closes the victory gap or waiting another turn would miss the projected
finish of the rest of the winning plan. Financing and knight play limits determine
the preparation time; a held knight uses its play schedule rather than the cost
of future purchases to decide when to act.

An immediately fundable takeover also qualifies when removing the holder's two
points breaks their projected finish within one turn. Executable road takeovers
take priority over ordinary investments, after an available win. Productive
settlement routes and knights that unblock our production remain available early.
An inactive army contributes no expected army points to a dev purchase.

Regression coverage includes early bonus deferral, hidden VP and 15-point targets,
knight deadlines, urgent versus distant holders, unfunded denial, legal expansion,
and winning road construction. Timing remains an expected-income approximation;
this change does not establish a win-rate improvement or change Year of Plenty.

The bot now evaluates growth and point conversion against the earliest estimated finish by either player. There is no four-point phase switch, minimum Monopoly haul, automatic port ownership reward, or live “behind means buy dev cards” override.

## Evidence from retained games

The September 14 export contains 40 records. A conservative audit requiring both of our setup settlements and an identified winner retains 14 wins and 21 losses; five captures have incomplete history. Nineteen of the 21 retained losses ended with lower recorded production. None contains enough decision-time information for exact replay.

| Record (UTC finish) | Observed behavior | Validation of the revised behavior |
| --- | --- | --- |
| Loss, 2026-09-13 22:39:38 | Five dev purchases before the first city; 11 dev purchases total; one city; final production 59 versus 91 pips. | An affordable dev competes with saving for a productive city. Horizon tests cover both city saving and immediate point conversion as the race shortens. |
| Loss, 2026-09-13 23:19:33 | Sixteen dev purchases; a Monopoly play with no recorded haul; final production 76 versus 91. The missing haul alone does not prove zero cards. | The reproduced ten-wood, zero-ore position cannot select ore. An exact positive target is required at selection and dispatch. |
| Win, 2026-08-21 10:42:50 | One dev purchase before the first city, four cities, final production 78 versus 66. | Productive city investment remains available and can outrank an affordable dev. |
| Win, 2026-09-13 23:07:21 | Fifteen dev purchases, four cities, and Monopolies for three wheat and five brick. | Dev purchases and small Monopolies remain legitimate options. A one-card Monopoly that funds the winning city is explicitly tested. |

This compares observed failure patterns and retained successful actions with regression scenarios. It does **not** establish alternative wins or a win-rate increase. The old records omit resource payouts, exact hands, opening coordinates, and often the victory target. Reconstructing those missing values would manufacture evidence.

Reproduce the read-only audit with:

```sh
node scripts/analyze-game-logs.mjs /path/to/catan-copilot-gamelogs.json
```

## Tracking and replay

In 1v1, all steals are transfers inside the two-player resource pool. Replaying every bank inflow/outflow and subtracting our private hand recovers the opponent's resource identities even when a steal icon is missing. Both server totals and known private movements must agree. Duplicate event IDs replace previous observations; late rows are ordered before replay. A gap, contradiction, or absent opening history is exposed as repairing/incomplete, never resolved by deleting the opponent's largest pile.

New logs retain typed events, decision-time hands and health, board geometry and positions, player planning inputs, evaluated alternatives, and confirmed outcomes. `replayPlanning` re-evaluates a captured position and explicitly rejects missing state or unresolved hands. Generic action confirmation and Monopoly haul confirmation are separate; a sent action is not automatically counted as successful.

## Scope of the estimate

Completion times use resource-specific production, holdings, trade ratios, verified expansion routes, piece supply, returned settlement pieces, future city upgrades, existing bonus ownership, and knight timing. Port value comes from surplus that can actually be converted. Robber tests distinguish a sole wheat bottleneck from a position where wheat is already in hand.

The evaluator remains a bounded expected-value planner: it retains 24 candidate portfolios, searches Longest Road up to three added roads, and uses base-deck expectations for hidden opponent VP and future dev draws. It is not an exhaustive stochastic game solver or a calibrated win-probability model. Future production and trades are fractional expectations; executable trades still require whole cards. With no credible finite finish found, the growth valuation uses a provisional horizon instead of claiming a player is eliminated.

No live extension installation or new games were performed during this implementation.

## Follow-up: reciprocal bank trades and panel order

The audit also identifies reciprocal trade pairs. The August 22 19:01:01 loss traded three ore for wheat, then three wheat for ore with only an own roll recorded between them. The August 22 20:17:15 win traded four sheep for wood, then four wood for sheep with no intervening own action. These mistakes also occur in wins; retaining wins in the audit prevents treating all winning actions as good policy.

Main-game bank trades now require that the selected build can be completely funded. Its target stays fixed across the trade sequence, while a newly available immediate win can still take precedence. Otherwise the bot keeps the cards, retaining its option to trade later instead of paying a guaranteed loss merely to get below the discard limit. Regression tests cover holding an over-limit wheat hand for an unfunded city and completing a two-trade purchase without exchanging acquired cards back.

The panel has been visually reordered: play checkbox, board and plan, player hands, balanced dice, evaluation, strategy, then Rush mode/history/downloads/record. Existing controls and event handlers are retained. The built-bundle smoke test asserts the section order.

## Final verification

- 240 unit tests passed; TypeScript check and production build passed.
- Both built-bundle smoke checks passed: overlay/control order and exact-hand recovery across steals, reversed delivery, duplicates and reconnect.
- Firefox lint: zero errors/notices; four dynamic-innerHTML warnings remain.
- On the validation machine (Node 25), tests used `NODE_OPTIONS=--no-experimental-webstorage` to prevent Node's experimental global storage from shadowing jsdom storage.

## v1.20: September 14 follow-up

The next export retained the UziYamal win (18:31 UTC) and simpy007 loss
(19:09 UTC). Both are marked incomplete: missing log history prevents an exact
opponent-hand replay. The committed decision fixtures preserve this health;
tests reproduce observed inputs without declaring the histories exact.

Two concrete bugs explain the reported behavior:

- `turnsToAfford` combined fractional bank credits from unrelated resource
  piles immediately after time zero. A ten-card hand with no sheep and no
  four-card surplus therefore forecast a settlement in 0.000000004 turns.
  The executor correctly refused the illegal conversion, but the imaginary
  investment outranked executable cities. Forecasts and successive-build
  financing now require whole conversions per resource.
- The wire VP-source enum was wrong: source 2 is held VP cards, source 4 is
  Longest Road. The private capture ties source 4 directly to
  `hasLongestRoad: true`. The simpy game's actual public scores were 7–13,
  while the old interpretation reported 9–11. In the Uzi win the bot's road
  was length 12 versus 7, yet its ownership flag was false. It could reward
  further roads with a bonus it already owned. Live planning now reads the
  authoritative road mechanic, with the corrected VP-source fallback.

| Captured decision | Old action | Revised action with recorded inputs |
| --- | --- | --- |
| Uzi win, 32: ten cards including 3 ore and 4 wheat | End turn | Build city |
| simpy loss, 75: 12 wood and 7 wheat | End turn | 4:1 trade funding city at vertex 3 |
| simpy loss, 77: same 19-card hand | End turn | 4:1 trade funding that city |
| simpy loss, 79: 12 wood, 7 wheat, 2 ore | End turn | 4:1 trade funding that city |

Saving an over-limit hand now includes an approximate expected discard cost,
using the counted seven probability and the reserve retained after discarding.
This decreases the value of waiting without forcing wasteful purchases. Existing
regressions still preserve a near-ready productive city reserve and reject
unfunded conversion loops. The risk approximation does not simulate every future
roll, hand, or discard.

Longest Road search still has a three-addition bound. Within that bound it
prefers the fewest pieces, breaks equal-length ties by productive settlement
access within the remaining supply, and does not offer an already-held bonus.
No verified route means search uncertainty, not elimination.

The old softmax value was a relative ranking, not a calibrated win probability.
The panel now displays expected turns to finish instead of percentages such as
98%. Corrected scores and financing improve the underlying forecast, but dice,
hidden cards, opponent decisions and incomplete capture still limit its accuracy.
These replay checks establish corrected decisions, not hypothetical wins or a
measured win-rate improvement.

Validation for v1.20: 250 tests passed; TypeScript, production build and both
built-bundle smoke checks passed. Firefox lint reports zero errors/notices and
four existing dynamic-innerHTML warnings. No new live games were played.
