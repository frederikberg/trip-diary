# Development

`bun install`, then:

- `bun run build` builds the client into `dist/`; `bun run dev` serves with a watcher.
- `bunx tsc --noEmit && bunx biome check . && bun test test/` is what CI runs on every pull request.
- Sample data (a synthetic hike, a map of invented people) is in `test/fixtures/hike.json`, `e2e/sample.ts` and `e2e/sample-map.ts`.

## Tests


| What | Command | Where |
|---|---|---|
| Unit and API tests (fake Immich, geocoder, OSRM and DB, temp SQLite), a few seconds | `bun test test/` | CI on every PR |
| Types, lint | `bunx tsc --noEmit && bunx biome check .` | CI |
| Browser self-test: phone 390×844 touch and desktop 1440×900, 132 checks (login, trip list, expired login with a queued placement, offline placement, a long trip title, every pin on its spot at two zooms, the photo picker, notes without a place, a new trip, its settings, read links and a day offset included), screenshots | `bun run build && bun e2e/selftest.ts [out-dir]` | developer, before a UI change ships |
| Typing in the note editor on an iPhone-sized page, WebKit and Chromium: text and caret stay where typing left them while the visual viewport reports keyboard and pan changes; a draft in the stored shape opens; editor screenshots at 390×844 and 1440×900 | `bun run build && bun e2e/typing.ts [out-dir]` | developer, before an editor change ships |
| The map page by real touch at 390×844 and by mouse at 1440×900: every action, keyboard stability, safe areas, tap targets, a second reader, conflicts, screenshots. Needs the network for the tiles, and WebGL in software (`webglArgs`) | `bun run build && bun e2e/map.ts [out-dir]` | developer, before a map page change ships |
| The app with sample data on a fake Immich and a fake geocoder, for looking at it; prints the links, the map's too | `bun run build && bun e2e/stack.ts [port]` | developer |

Browsers come from `e2e/browsers.ts`: `CHROMIUM_PATH`, else the newest
`~/.cache/ms-playwright/chromium_headless_shell-*`; `WEBKIT_PATH`, else Playwright's own WebKit
(`bunx playwright-core install webkit`, which may need host libraries on a minimal Linux). A browser
that does not launch is a failed check. On a busy machine software WebGL makes `e2e/map.ts` slow, and
a check that waits on a toast can miss it. `e2e/typing.ts` runs the stack on https with a throwaway
self-signed certificate (needs the `openssl` binary). The stack serves the public origin on
`127.0.0.1` and the editing origin on `localhost`; `playProxy` (`e2e/stack.ts`) adds the identity
header to a browser context's requests to the editing origin, as the proxy's login would. The browser
tests run against their own temporary database and a fake Immich; read their screenshots, a green run
says nothing about how it looks. The headless shell has no H.264 and none of the iOS fonts, so video
playback and typography are checked on a real phone.

The note editor is a page in normal document flow while open: nothing fixed or sticky holds the
text field and no script follows `visualViewport`. A fixed overlay sized and moved from
`visualViewport` while its field had focus showed, on iPhone Safari, the caret in an earlier word
than where the text went and the sheet beside the overlay — most likely WebKit's caret drawing
lagging a moved fixed box and iOS reporting a stale `offsetTop`, not confirmed on a device. The
typing test fails on any editor that moves its field on viewport events. Playwright's WebKit has
no on-screen keyboard and no iOS text interaction, so the test feeds the viewport values iOS
reports, and the caret itself is only seen on a real phone.

