# Catan Copilot for colonist.io

A Firefox extension that overlays [colonist.io](https://colonist.io) with a live
strategy copilot. It reads the game log and the game's WebSocket board state as
you play and keeps up-to-date:

- **Where to build** — a mini-map of the live board with numbered gold badges on
  the exact intersections to take: initial-settlement picks during setup (the
  2nd pick biases toward resources your 1st spot lacks), expansion targets in
  the main game, and dashed segments for the next roads to lay toward spot ①.
- **Card counting** — every player's hand, tracked through rolls, builds, trades,
  discards, monopolies, and steals (unknown steals show as `±n` uncertainty).
- **Balanced-dice deck tracking** — colonist's balanced mode draws from the 36
  two-die combinations like a card deck. The overlay counts the deck down, shows
  which numbers are over-due or exhausted, and the probability your numbers hit
  the next roll.
- **Strategy advice** — it learns each player's number→resource income table from
  the log, scores four predefined strategies (Road & Expand, Cities & Development,
  Port Monopoly, Balanced), forward-simulates each with balanced dice, and
  recommends one with rationale.
- **Robber advice** — who to rob and which of their numbers to block, based on
  visible VP, income, and hand size.
- **Trade tips** — what you're one trade away from building, what to offer, and
  your best observed bank/port ratios.

Advice is available by default. **Experimental autopilot is optional and off
at the start of each session**; when enabled, it can perform gameplay actions.

## Install permanently (Firefox 140+)

Install the **Mozilla-signed `.xpi`** once:

1. Open `about:addons` in Firefox.
2. Open the gear menu → **Install Add-on From File…** and select the signed XPI.
3. Accept the installation and data permissions, then open or refresh
   colonist.io **before joining a game**.

The extension stays installed when Firefox quits. It is privately distributed,
with no public Firefox Add-ons listing. To update, install a newer signed XPI
using the same menu; no reload is needed after ordinary browser restarts.

### Build and sign your own copy

Requires Node.js 22+, npm, and `zip` (included on macOS).

```sh
npm ci
npm run package:firefox
```

This creates `dist/firefox/catan-copilot-<version>-unsigned.zip` and
`dist/firefox/catan-copilot-<version>-source.zip`. **The unsigned ZIP cannot be
installed permanently in normal Firefox.**

For one-time signing setup, sign in to the
[Mozilla Developer Hub](https://addons.mozilla.org/developers/) and obtain
[API credentials](https://addons.mozilla.org/developers/addon/api/key/).
Set `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` in your local shell environment
using a secure prompt or password manager; do not commit them or paste them
into chat. Then run:

```sh
npm run sign:firefox
```

This rebuilds and lints the add-on, uploads the review sources, and requests
**unlisted** signing. Install the signed `.xpi` downloaded into `dist/firefox/`.
Signing may await Mozilla review; check the Developer Hub if it times out.
For updates, bump the manifest version, keep the extension ID, and sign again.
See [BUILDING.md](BUILDING.md) for reproducible builds and reviewer notes.

### Data permissions

The optional local coaching server receives player usernames, game state,
move history, and game results via `127.0.0.1:8137`. The extension attempts
these local requests automatically; it continues working when no server is
running. Firefox's installation prompt declares usernames, website content,
and website activity. Local game records and learned actions also persist
in colonist.io localStorage. Firefox 140+ provides the built-in consent prompt.

### Development: temporary loading

1. Run `npm ci && npm run build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.
4. Open or refresh colonist.io before joining a game.

Temporary add-ons unload when Firefox quits. Use the signed XPI above for
normal use. `npm run lint:firefox` rebuilds and validates the extension.

The manifest is MV3 and registers `inject.js` as a MAIN-world content script
at `document_start`, so the WebSocket wrap is synchronous — no injection race
with colonist's own scripts.

## How it reads the game

Two read-only channels:

1. **Game log (DOM).** Colonist renders its log as a virtual scroller of
   `[data-index]` rows. The content script sweeps existing rows in index order
   (so a mid-game refresh rebuilds full history), then follows new rows with a
   MutationObserver. Rows are parsed by icon alt text (`dice_4`, `grain`,
   `wool`, `lumber`, `settlement`, …) and text keywords ("rolled", "built a",
   "gave bank … and took", "stole … from you", …). The signed-in player comes
   from `.web-header-username`.
2. **Board state (WebSocket).** `inject.js` runs in the page world, wraps
   `window.WebSocket` before colonist connects, decodes the msgpack frames, and
   forwards board-relevant events (board description type 14, build corner 16,
   build edge 15, play order 8, player states 12) to the content script.
   Colonist's hex-face coordinates are the same axial system the engine uses,
   so tiles, ports, corners, and edges map 1:1 onto the tested board model in
   `src/engine/` — which then scores placements on the real board.

Both channels' formats follow open-source colonist tooling — see Sources.
If the extension is loaded mid-game the board frame has already passed;
refresh the page and colonist resends it. The overlay says so when the board
is missing, and all log-based features keep working without it.

## Layout

```
extension/            manifest (MV3) + built content.js and inject.js bundles
src/extension/
  content.ts          bootstrap: find log, sweep history, observe new rows,
                      receive board events from the page tap, run autopilot
  inject.ts           page-world WebSocket tap + send channel
  msgpack.ts          minimal MessagePack codec (decode + encode)
  coords.ts           engine pixel positions -> colonist wire coordinates
  protocolLearner.ts  learns action-message templates from manual play
  autopilot.ts        turn executor: decide -> send -> await confirmation
  learning.ts         game-outcome records -> strategy score priors
  boardBridge.ts      colonist board/build payloads -> engine Board/GameState
  placement.ts        where-to-build advice + mini-map SVG renderer
  logParser.ts        DOM row -> typed GameEvent
  tracker.ts          GameEvent stream -> per-player state + income tables
  copilot.ts          deck tracking, strategy ranking, board-free simulation,
                      robber + trade advice
  overlay.ts          the injected panel (vanilla DOM, light/dark)
src/engine/           board-aware engine (generation, analysis, strategies,
                      balanced-dice simulation) — scores placement on the
                      real captured board
scripts/smoke.mjs     end-to-end check: built bundle vs. a fake colonist page,
                      including simulated board WebSocket events
```

`npm test` runs 52 unit tests (engine, parser/tracker/copilot/overlay,
msgpack/bridge/placement); `node scripts/smoke.mjs` runs the built bundle
against a synthetic page.

The overlay's resource colors were validated for color-vision-deficiency
separation and contrast in both light and dark mode with a palette validator;
every colored mark is also direct-labeled, so color never carries meaning alone.

## Autopilot (experimental, self-learning)

Colonist's outbound action-message formats aren't documented anywhere, so the
extension **learns them from watching you play**:

1. Every frame you send while playing manually is captured; when the game
   confirms an effect (a build event, a roll in the log, a turn change), the
   learner pairs the confirmation with the frame that caused it and stores a
   template — coordinate slots and sequence counters identified automatically.
   The overlay's Autopilot section shows the learned set: `✓ settle · road ·
   ✓ roll …`. Templates persist in localStorage.
2. Flip **"Play my turns"** and autopilot performs learned actions on your
   turn: roll, play a knight when the robber blocks your tile or the plan is
   Cities & Development, then the recommended build order (city upgrades,
   settlements on your network, dev cards, roads toward expansion ①), then
   end turn — one action at a time, each required to be confirmed by the game
   before the next. On a 7 it places the robber on the best opposing tile and
   picks the discards that keep your next build intact.
3. **It learns from its mistakes**: a sent action the game never confirms
   proves that template wrong, so it is un-learned automatically; do the
   action manually once and it re-learns from the fresh pairing. Game results
   also feed back — each finished game records win/loss against the strategy
   style you actually played, and those records nudge future strategy scores
   (bounded ±15%).

**Play my turns** remembers your preference and defaults on. The separate
**Continue autoplaying games** checkbox defaults off: the bot finishes and saves
the current game, then leaves the results visible. Enable it to advance through
the results and queue another game. Both preferences persist independently; the
standalone autoplay runner also honors continuation being switched off.

Bank trades and forced discards each pause for a random 0–2 seconds before
execution. Spending decisions compare holding cards with buying a development
card and continuing toward the planned build, including incoming production and
partial reductions in expected discards.

**Fair-play caution:** automating moves violates colonist.io's terms on games
with strangers and can get an account banned. Use it against colonist's AI
bots or in private games where everyone consents.

## Sources

Colonist.io DOM structure and log-message taxonomy per these open-source
projects and references:

- [nickincardone/catan-counter](https://github.com/nickincardone/catan-counter)
- [movcmpret/colonist-enhancer](https://github.com/movcmpret/colonist-enhancer)
- [glasperfan/explorer](https://github.com/glasperfan/explorer)
- [Elijah-Adams/colonist-extension](https://github.com/Elijah-Adams/colonist-extension)
- [Reverse engineering games for fun and SSRF](https://www.nc-lp.com/blog/reverse-engineering-games-for-fun-and-ssrf-part-1)
