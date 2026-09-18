# September 18 game-log analysis

The highest-priority improvement is to stop selecting unavailable knights. The retained games also support testing stronger wheat access in setup, better treatment of repeated discard exposure, and opponent responses to Longest Road takeovers. These are observations and proposed improvements, not measured gains in win rate.

## Data and limits

Downloaded `catan-copilot-gamelogs-1789751162493.json` from the existing Firefox Colonist tab on September 18. The export contains four games, all labeled `v1.27 endgame-defense`, with 559 decision snapshots. A working copy, metrics, readable move transcripts, and the analysis runner are in `.context/analysis-2026-09-18/` (git-ignored). The original remains in Downloads.

The panel shows 81 lifetime results, but only four retained detailed logs. `saveGameLog` evicts older games when browser storage fills, even below its 40-game limit. The export therefore does not support an audit of all 81 games.

All four records have identified winners and both of our setup settlements, but all have `complete: false`. Their event-ID sequences have gaps (36, 30, 40, and 36 respectively). Of the 559 snapshots, 435 mark both hands exact; this does not make the entire event history or balanced-dice reconstruction exact. The amberwaves record has only seven such snapshots. Winner events support reporting one observed win and three observed losses, while the existing conservative analyzer excludes all four from its complete-history win/loss totals. Its `exactReplayable` field checks structural availability, not exact hands or event continuity.

Final VP fields are public scores and may omit hidden victory cards or lag the winning update. They should not be interpreted as final total scores. Decision indexes below are zero-based within the export.

| Opponent | Outcome | First city: own recorded roll | Cards discarded | Our/opponent final pips | Knight selections without a recorded knight |
| --- | --- | ---: | ---: | ---: | ---: |
| kanfetka69 | Win | 4 | 6 | 89 / 102 | 0 |
| amberwaves | Loss | 25 | 5 | 65 / 62 | 19 |
| ForneroBJ | Loss | 33 | 31 | 53 / 71 | 0 |
| Guenter66 | Loss | 27 | 25 | 85 / 75 | 43 |

Pips measure recorded production potential, not realized resource income. Two losses had higher final pips than the opponent; accumulating production alone is insufficient.

## 1. Fix unavailable-knight selection before tuning strategy

**Strong evidence:** 62 captured `play-knight` selections lack card ID 11 in `devCardIds`. None has a recorded confirmation. In the Guenter66 game, all 43 knight selections have this problem and our move history contains zero knight plays. Later selections show only `[12,12]`, two victory-point cards. These are selections, not necessarily 62 distinct server-accepted actions or lost turns.

The code explains a plausible mechanism: `Autopilot.tick` in `src/extension/autopilot.ts` uses `wireKnightCount || DOMKnightCount`. An authoritative count of zero therefore falls back to DOM imagery. `countKnightsInHand` in `src/extension/content.ts` scans images using label and screen-position heuristics. The exact falsely matched DOM image is not captured, so its identity remains unverified. The timeout path discards the learned action template but does not stop the same action from being selected again.

Selected observational replays through the current `replayDecision` helper, which omits knight availability, expose the opportunity cost:

| Game / decision | Captured hand: wood, brick, sheep, wheat, ore | Captured action | Replay with unavailable knight omitted |
| --- | --- | --- | --- |
| amberwaves / 55 | 2, 2, 1, 1, 3 | Play knight; no dev cards | Road for a funded settlement |
| amberwaves / 117 | 4, 8, 2, 6, 4 | Play knight; no dev cards | Buy development card |
| Guenter66 / 38 | 1, 1, 4, 1, 3 | Play knight; no dev cards | Trade four sheep for wheat to fund a city |
| Guenter66 / 128 | 9, 3, 3, 4, 0 | Play knight; only two VP cards | Road for a funded settlement |

The Guenter66 decision-38 hand can finance a city directly after that legal trade. Decision 128 already has the cards for a road-and-settlement sequence. Both players' hands are marked exact in those snapshots. Amberwaves' opponent hand is incomplete; those replays retain that uncertainty. Replays are single-position diagnostics, assume the post-roll decision phase, and do not reproduce all executor state or prove a different game outcome.

**Recommended change:** distinguish missing wire information from a known empty hand; only consult DOM counts when wire information is unavailable. After an unconfirmed action, suppress retries until relevant state changes and reconsider legal alternatives. Check dev-card age and the one-dev-per-turn rule explicitly.

**Acceptance:** these captured positions never select a knight; useful builds/trades remain executable; valid old knights still play; a failed dispatch cannot repeatedly monopolize subsequent decisions.

## 2. Improve wheat access in the opening

Against ForneroBJ, our opening production was wood 6, brick 4, sheep 4, wheat **1**, ore 5 pips. The opponent had seven wheat pips. We covered all resources, but wheat access was extremely weak. Our first city came on our 33rd recorded roll, versus roll four in the win. We bought two development cards before that first city and eventually paid eight brick for the two wheat used immediately before it.

**Recommended strategy:** score the setup pair by time to the first productive city and useful expansion, including starting resources, integer bank trades, robber exposure, and reachable ports. Resource coverage alone should not make a one-pip wheat opening attractive. Accept weak wheat when a credible port or fast wheat expansion compensates. Compare those alternatives on the captured board rather than imposing a universal wheat-pip cutoff.

The win supports preserving productive early cities and efficient port conversion, but this small sample does not establish that every opening should rush cities.

## 3. Revisit long waits with surplus and recurring discard risk

ForneroBJ is the cleanest strategy example because it has no phantom-knight selections. We discarded 31 cards across six events and deliberately ended five captured decisions above the nine-card limit. Decision 68 held `5 wood, 5 brick, 1 sheep, 0 wheat, 1 ore`, saving roughly 3.6 turns for a city while reporting 37% estimated seven exposure. Decision 87 held 14 cards and accepted 38% exposure. Current replay reproduces both holds.

The current discard heuristic enumerates incoming production and repeated discards until the next spending opportunity. The earlier analysis incorrectly described these as absent, based on outdated documentation. Wheat starvation can repeatedly refill surplus wood/brick without completing the intended purchase, and the short horizon does not model the entire wait for a build. Guenter66's 25 discarded cards are additionally confounded by unavailable-knight stalls; fix those before attributing all of that waste to the spending heuristic.

**Recommended strategy:** compare waiting against legal useful purchases and partial conversions over several roll outcomes, including additional income, repeated sevens, conversion costs, and time lost to the city. Preserve the option to hold for a valuable near-ready city; do not blanket-spend every over-limit hand. Use decision 68 as a benchmark rather than assuming that the observed discard alone proves the hold was wrong.

## 4. Value how long a contested bonus can be retained

In Guenter66 decisions 157–160, the bot traded three wheat and three sheep for two brick and built two roads, taking Longest Road: the captured length moved from seven to ten against nine. At decision 161, our recorded public score was 12 plus two hidden VP—still one short of winning. The opponent then built two roads, played Road Building for two more, retook the bonus, built a city, and won.

The takeover did deny an opponent already near victory, so the result alone does not establish that it was a mistake. However, valuing the takeover as a durable two points misses the immediate response risk.

**Recommended strategy:** evaluate an affordable opponent extension and the chance of Road Building before relying on the bonus for a finish. Prefer a takeover that wins immediately or finances a defensible follow-up; retain emergency denial when it is the best available chance. Treat hidden dev-card identity as uncertain, not retrospectively known.

## Validation and next order of work

Ran the existing historical analyzer, independently counted all four move histories, and ran ten selected observational decision replays against the current source. Detailed results are in `.context/analysis-2026-09-18/metrics.json`; rerun the bundled audit from the repository root with `node .context/analysis-2026-09-18/analyze.mjs`.

Implement and regression-check unavailable-knight handling first. Then compare setup wheat access and discard-aware choices using captured positions and controlled games. Add opponent-response evaluation for bonus races. Persist logs outside browser quota so future comparisons include a larger cohort and executor confirmation/timeouts. No production strategy code was changed and no new games were started during this analysis.

## Follow-up: confirmed fix only

The user's follow-up explicitly favors avoiding over-tuning. Opening weights,
discard valuation, and Longest Road policy remain unchanged pending more data.
The only implemented behavior change is the reproducible unavailable-knight bug:
`Autopilot.tick` now respects a supplied wire inventory, including zero knights,
instead of overriding it with DOM imagery. DOM fallback remains available when
that inventory is omitted. No general retry policy or new strategy heuristic was
introduced. The rebuilt bundle is labeled `v1.28 verified-knights` for attribution.

Before the fix, two executor regressions selected `play-knight` despite an
affordable city and wire inventories `[]` / `[12,12]`. Both select `build-city`
afterward. Controls cover genuine wire knights, DOM-only knights, one play per
turn, and freshly bought cards. Local executor checks of original Guenter66
snapshots 38 and 128 now select the useful bank trade and road respectively.
The full local run passed 344 tests (342 repository tests plus two local captured
position checks); TypeScript and production builds passed. Firefox lint could
not run because the installed dependencies lack the `web-ext` executable.
The rebuilt extension has not been installed into the running Firefox session.

Both standalone bundle smoke scripts failed locally: `smoke.mjs` at the
heading-order `compareDocumentPosition` assertion, and `smoke-ledger.mjs` at
its opening-ledger exactness assertion. Running the same scripts against the
unchanged `HEAD` bundle reproduced both failures. They are existing baseline
failures in this environment, not introduced by the knight-availability change;
they remain unresolved and limit bundle-level verification.

## Follow-up: improve discard spending without fitting new weights

After the user requested better use of surplus resources, the v1.29 spending
comparison was adjusted to avoid adding the full conversion penalty on top of
the lost future-build value caused by the same depleted budget. It uses the
larger cost estimate, retaining a conversion-loss floor. Two Fornero snapshots
now trade four surplus wood/brick for wheat and then buy a development card;
their six/eight-card remaining hands have lower modeled discard exposure. The
city delay remains part of the decision. A third older fixture changes similarly.

Existing controls still reject wasteful exchanges, preserve valuable city
savings, prefer the immediately fundable city in the retained regression, and
prevent reverse trades. The implementation does not change opening weights,
Longest Road policy, discard thresholds, or the dice model. See
`1v1-strategy-validation.md` for the comparison's scope and numerical results.
