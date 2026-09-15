# Mozilla review: Catan Copilot

## Reproduce the submitted JavaScript

Use Node.js 22 or later and npm on macOS or Linux. Unzip the source archive
into an empty directory, then run:

```sh
npm ci
npm run build
```

Vite compiles `src/extension/content.ts` and `src/extension/inject.ts` into
`extension/content.js` and `extension/inject.js`. Both builds are unminified
IIFEs; there is no downloaded runtime code. Compare these files byte-for-byte
with the same files in the submitted add-on. The source ZIP includes the
lockfile, build configuration, and all application TypeScript; captured game
fixtures, tests, credentials, and generated bundles are excluded.

`npm run package:firefox` additionally requires the `zip` command (included
with macOS; install your distribution's zip package on Linux). It builds,
lints, and creates the unsigned add-on ZIP and this source ZIP in
`dist/firefox/`. The manifest version determines artifact names; the npm
package version and in-game strategy version are separate identifiers.
The build also includes the strategy version in the extension's display name,
using `src/extension/version.ts` so the browser title and in-game header agree.

## Reviewer notes and data disclosure

The add-on runs only on colonist.io. The MAIN-world script observes the game's
WebSocket traffic; the isolated content script parses game logs and displays
card counts, board advice, and an optional experimental autopilot. Autopilot
starts off each session and can send gameplay actions when enabled. Test with
AI opponents or a consenting private table; enable the add-on before entering
the game so it can capture the initial board state.

The content script attempts to POST game summaries to
`http://127.0.0.1:8137/state` and completed game logs to
`http://127.0.0.1:8137/gamelog`. These include player usernames, game state
(including the user's hand), moves, results, and strategy advice. The local
coaching bridge can store this on the user's computer. No bridge is required
to use the overlay: failed requests are ignored. The add-on has no analytics
endpoint. Learned action templates and game records also use colonist.io
localStorage.

The manifest declares `authenticationInfo` for usernames, `websiteContent`
for game state and logs, and `websiteActivity` for gameplay actions. These
permissions are required because the existing bridge attempts transmission
without a separate toggle. Firefox 140+ is required to show built-in consent
at installation. This release preserves the existing runtime behavior.

## Signing and updates

Set `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` locally using credentials from
https://addons.mozilla.org/developers/addon/api/key/, then run
`npm run sign:firefox`. The command rebuilds, lints, and submits the extension
and source archive to Mozilla with `--channel=unlisted`. Credentials are read
from the environment and are not included in either archive.

Install the signed `.xpi` downloaded to `dist/firefox/` through Firefox's
Add-ons Manager. Mozilla may require review before releasing the signature;
an unsigned ZIP is not a persistent installation artifact. If signing times
out, check the submission in the Mozilla Developer Hub before resubmitting.
Download the approved signed file there if needed.

For each update, increase `extension/manifest.json`'s version and keep
`browser_specific_settings.gecko.id` unchanged. Sign again, then install the
new signed XPI over the existing add-on. There is no public store listing or
automatic update server.
