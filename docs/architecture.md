# Architecture

How the code is laid out and why. The HTTP contract is [`src/shared/api.ts`](../src/shared/api.ts);
every setting is in [`config/config.yaml`](../config/config.yaml); the proxy and login wiring is
[self-hosting.md](self-hosting.md).

One Bun process serves the API, the media proxy and the built client.

- `src/shared/api.ts` — **the contract**: every route, its auth, status codes and every
  request/response type. Server, web client and CLI clients import it; change it first.
- `src/server/` — `main.ts` (wiring) · `config.ts` (loader) · `db.ts` (schema migrations, row
  access; WAL) · `http.ts` (error type, response helpers, body validation) · `app.ts` (routing, auth, trip handlers) ·
  `maps.ts` (map page, token API and admin API) · `geocode.ts` (Photon client) · `home.ts` (the start page) · `view.ts` (rows → API shapes)
  · `ordering.ts` (the timeline rule, its only implementation) · `immich.ts` (Immich client and
  proxy fetch) · `tokens.ts`. `src/shared/time.ts` is the zone arithmetic server and client share.
- `web/` — the client, vanilla TS bundled by `scripts/build-web.ts` into `dist/`:
  `main.ts` (selection controller, history layers, band rule) · `map.ts` · `strip.ts` ·
  `sheet.ts` · `player.ts` (inline video) · `viewer.ts` (PhotoSwipe) · `edit.ts` · `picker.ts` (the photo picker) · `immich-link.ts` (the asset id in a pasted link) · `api.ts` · `util.ts` · `styles.css`.
  `web/map/` is the map page's own client: see *Maps*.
- `GET /<viewToken>` returns `dist/index.html` with the whole `TripView` inlined, so the first
  paint is one request.
- Media: the browser only ever sees `/api/t/<token>/m/<mediaId>/<size>`. The server checks the
  media row belongs to the token's trip and fetches from Immich with its key (Range passed
  through). Photos and videos come only from Immich: there is no upload route and no media
  storage; the `media` table's `source`, `file` and `bytes` columns are leftovers the code neither
  reads nor writes (`source` is always `immich`).
- Videos: in the open note a video plays in its own tile (`player.ts`), muted and playsinline; the
  tile's corner button opens the viewer, whose videos start on arrival with sound and answer the
  space bar. Two switches above the row, autoplay and mute (both on by default), live in
  `localStorage` (`trip-video`) and apply to every note; mute concerns only the tiles. One video
  plays at a time: a note's videos follow one another (the row scrolls to the one playing, the last
  hands over to the first), a single one loops. Sound without a tap is refused by iOS, so a start the
  browser refuses runs muted and the switch shows it. Leaving a note, closing the sheet or opening
  the viewer stops its videos and drops their source, so no connection to Immich stays open, and the
  tiles load nothing until they play (`preload="none"`).
- Attaching: the editor's "Foto" button opens the picker, a page in normal document flow like the
  note editor: Immich thumbnails of four hours around the note's anchor, whole hours, moved by
  "früher"/"später", the note's own time drawn between them. Taps pick, one button attaches the
  picked ones in the order they were taken (`POST …/notes/<key>/media {immich_id}` each, a 409
  skipped), ones already on the note are greyed out. A pasted Immich photo page link
  (`…/photos/<id>`, also with an album or person in front) or a bare asset id still works at the
  page's end. The picker reads through two editor-only routes on the view token (`…/suggest` and
  `…/immich/<id>/thumb`), checked by the login alone since browsers send no `Origin` on a
  same-origin GET or an `<img>`; the thumbnail route serves any asset of the key's library, which
  the editor could already reach by attaching it. The search stays inside the trip's window, which
  the notes' times widen, so today's photos are found while today's track is not recorded yet; an
  iPhone photo appears only once the Immich app uploaded it, and an empty recent window says so.
  The app only reads Immich: asset lookups, thumbnails, video playback and the time-window search
  (a POST to `/api/search/metadata`, a read); its key may not write.
- Notes without a place: a numbered note's `lat`/`lon` may both be null. It then always has `at`
  (the table's CHECK holds it; made without one it gets its creation time), anchors by rule `at`
  on the day `dayAt` gives that time, has no pin and does not move the map when selected. It is
  made with "Ohne Ort" in the placing banner (offline too, through the outbox), loses its place
  with "Ohne Ort" in the moving banner (the server turns its anchor time into `at`, so it keeps its
  spot), and gets one back with "Ort setzen". The time button in the sheet's meta line opens a
  native `datetime-local` field for every numbered note, read and written in the trip's zone;
  "Zeit vom Track" clears `at` on a placed note. On iPhone that field opens the system picker, no
  keyboard, so it may sit in the fixed sheet.
- Anchors (timeline positions) are computed from the tracks when a view is built; nothing is
  stored, so adding a day re-sorts everything. Views are cached per trip revision (every write
  bumps it) and scope.
- Offline: a placement that fails for lack of network waits in local storage
  (`trip-outbox:<token>`) and is sent on `online`, on becoming visible and every 30 s; its
  `client_id` makes a retry find the note it already made. A 403 (the login ran out) keeps the
  queue and turns the edit badge into "Anmelden"; the queue survives the login round trip.

Boundaries: `app.ts` and `maps.ts` are the only places that know HTTP routes; `ordering.ts` knows no rows; `view.ts`
knows no HTTP. One concept, one name: a *note* (numbered or day-end), its *key* (`7`, `d3`), its
*anchor*; a *share* is a token row; on a map, an *entry* (a person, a couple, a household) has *places*.

## Maps (`maps.enabled`)

A map of people and places: anyone with the edit link changes everything, nobody has an account.
Contract: the map section at the end of `src/shared/api.ts`.

- **Links.** A map has `view` and `edit` shares (`map_share`, both tokens stored readable, because
  the admin lists them). `POST /api/admin/maps` returns one of each. The logged-in `/` lists each
  map with its newest live edit link. The share button on a write link offers `view_url` (the
  newest live view share) or the write link the page was opened with; on a read link it shares
  that read link.
- **A leaked write link:** `trip map share <map> --role edit --label …`, `trip map share <map>
  --revoke <id>`, then send out the new link. A view link the same way with `--role view`.
- **Data.** `entry.places` is JSON, an entry is edited as one unit. Every write stores the entry's
  state before it in `entry_rev` (`maps.history_keep` rows); `undo_rev` in the answer names that
  row, and `restore` with it is the undo toast. Delete is soft; the hourly purge removes entries
  older than `maps.trash_days`, and an edit link opened on the editing host (the login) may
  delete a trashed entry for good (`…/purge`, `can_purge` in the view; the admin always may). `by` is a free-text name, unverified.
- **Client.** `web/map/`, a second bundle so the trip page does not carry MapLibre: `main.ts`
  (panes, history layers, polling, undo) · `map.ts` (MapLibre, pins, clusters, long press, the
  draggable pin) · `cluster.ts` (pure) · `sheet.ts` (drag, modes, pane HTML) · `search.ts` · `form.ts`
  · `api.ts` · `util.ts` · `styles.css` · `style.json`. Open views poll with `If-None-Match` every
  20 s and on `visibilitychange`/`online`.
- **Last write wins, nothing ever warns.** A false conflict warning is worse than a lost edit here,
  and undo and the trash repair a real one. The form sends only the fields the user changed, without
  `If-Match` (the API keeps it for its own users); places merge by id onto the entry as it is at the
  save, so someone else's places stay. An open form takes in every field it has not changed. An
  unchanged form writes nothing and leaves no draft; a save onto an entry someone deleted meanwhile
  brings it back (`revived`, the toast says so). An overtyped address never saves onto the old pin:
  the row wants a suggestion, the map or an explicit "Alte Position behalten".
- **Budget.** An edit token has `maps.writes_per_minute`, far above real editing, so a runaway
  script or a leaked link cannot grind away the history quickly. Admin routes have none. Share
  changes bump `map.rev`, so editors' `view_url` follows a rotated read link.
- **Treffpunkt.** A map's selection (`meet_member`: entry, weight 1–4, car or train, which place) and
  its one last result (`meet_result`) live on the server and sync through the poll; only `Neu
  berechnen` computes, for everybody. `src/server/meet-algo.ts` is the arithmetic, `meet.ts` the routes
  and the job, `travel.ts` the only code that talks to the two services. The straight-line weighted
  middle comes with every view. The travel-time answer ranks the stations in `stations.json`
  (`scripts/stations.ts`, run by hand, one DB request per name) by the sum of weight × minutes²,
  the same rule the middle obeys on distance; the page shows the top three. Cars: one OSRM table
  (`router.project-osrm.org`: User-Agent, at most about a request a second, non-commercial, best
  effort; attribute it). Trains: DB Navigator `mob`, no key, station to station, the next Saturday
  9:00, one request per pair 1.1 s apart, process-wide, so only the ten best stations by car, plus the
  one nearest the middle, get train times. A train member within `meet.station_radius_km` of a
  station reaches it in 0 minutes; further away the car ride is added, and the station with the
  shortest ride among the six nearest is theirs, since a sea can lie before the nearest. No
  journey: that member counts by car, marked. A dead DB: everybody by car, and the result says so. A
  dead OSRM: the job ends with `job.error`, the old result stays. Times are cached
  `meet.cache_days` in `travel_time`, "no connection" only `meet.cache_none_days`. Both services go
  through a process-wide gate; a selection holds at most `meet.max_members`, as each member means
  more DB requests and all maps share that queue. A result is stale when `inputsHash` differs; the view computes
  that, the client only shows it. One job per map in this process: a restart loses it, nothing
  half-written. While a job runs, open pages poll `…/meet` every 2 s.
- **Avatare.** `avatar` holds pictures by content hash per map, so a URL never changes and undo
  works through the history snapshots; the purge drops what no entry and no snapshot names. The
  browser makes a 256 px JPEG through an `<img>` (handles orientation, no canvas of a full photo in
  memory beyond the decode); the file input stands outside the sheet, so a poll cannot replace it
  while the picker is open. The server trusts only the bytes: type and size come from them.
- **Failure.** A browser that cannot run the bundle keeps the sentence in `web/map.html`'s `#sheet`.
  One without WebGL 2 gets the list without a map (`noMap`).
- **Link preview.** `/m/<token>` carries Open Graph tags at the top of `<head>` (`<!--OG-->`, filled in
  `maps.ts`): the map's title, the live counts of entries and places, and a picture of the map's real
  places. The picture is `/preview/<preview_id>.jpg?v=<rev>` (`preview.ts`): `map.preview_id` is random
  per map, grants this picture only and is no view or edit token, so a write link never sits in a tag
  third parties fetch; read and edit links carry the same URL. Revoking a share replaces the id. The
  server decodes `web/static/map-base.jpg` (the base map without pins, rendered by
  `scripts/map-preview.ts` in the fixed `SECTION` of `preview.ts`, which also holds the projection
  from latitude and longitude to a pixel) and draws a disc per place of every live entry in the
  section: the entry's picture, else its palette colour (`src/shared/palette.ts`); no text, no
  clustering, northern pins first. Decoding and encoding is `Bun.Image`, so no package and no
  native module; it has no compositing, so `preview.ts` decodes through an uncompressed PNG, paints
  RGBA bytes and encodes through a BMP. The bytes are kept per map for the revision composed (at most
  `PREVIEW.kept` maps), compositions run one after another, and the image answers with the map's
  current state whatever `v` says. A map with no place in the section points at
  `/assets/map-fallback.jpg` (made-up pins, same script), and a composition that fails answers with it
  too. Assets are cached forever, so a new generic picture needs a new file name. Never names, addresses or a token in the tags: `?e=<id>` gets the same ones. `map-icon.svg`
  and `map-icon-180.png` are the page's icons. A new `SECTION` needs the script run again (it refuses
  one that misses Köln, Frankfurt, München, Hamburg or Berlin) and both files committed.
- **Base map.** `web/map/style.json` is OpenFreeMap's positron restyled by `scripts/map-style.ts`
  (run by hand, output committed, bundled into the client, which OpenFreeMap asks for with modified
  styles). Tiles, sprite and glyphs come from `tiles.openfreemap.org`, fetched by the browser, so
  that host stands in the map page's CSP (`MAP_CSP` in `maps.ts`). `build-web.ts` copies MapLibre's
  module worker to `dist/assets/maplibre-gl-worker.mjs`; `setWorkerUrl` points at it with the version
  in the query. Never set `position` on a marker element: MapLibre positions it.
- **Geocoder.** The pod asks Photon (`maps.geocoder_url`) over world:443, which the Deployment's
  network policy has to allow; visitors' IPs stay here (the tile host does see them, as browsers fetch tiles directly). Answers are cached 24 h in memory, each
  token has `maps.geocode_per_minute` upstream requests. The UI never takes the first hit by itself:
  Photon may answer with a same-named street elsewhere. Public Photon drops single requests, so the proxy retries once after
  `maps.geocoder_retry_ms` and the page once more; only then the UI says it is unreachable.
- **The form** is a page in normal document flow, as the note editor below explains; suggestions sit
  in the flow under their field. Every field is at least 16 px, or iOS zooms on focus. The search
  pill is fixed but never moved; the results end in room for the keyboard, and scrolling them
  closes it. The page itself is `position: fixed` outside the form, so it cannot bounce.
- **Pins at one address.** Places a few metres apart (a household with an entry per person) share a
  spot: once their cluster holds nothing else, their pins stand side by side instead of collapsing
  into a number (`fanOut` in `cluster.ts`, limits beside `CLUSTER_RADIUS` in `map.ts`). The link
  preview picture draws them on top of each other.
- **Touch.** In peek the whole sheet drags; in half and full the head does and the body scrolls. A
  drag captures the pointer only after 8 px, so a tap stays a click on its row. Long press is timed in
  `map.ts` (iOS sends no `contextmenu`, Android does); the click some browsers send on release is
  swallowed.
- The test hook `window.people` exists only under `navigator.webdriver`.
- **Not verified on a device:** emoji input, the real Signal link preview (the tags and the picture
  are checked with Signal's `WhatsApp/2` User-Agent by curl), Google Maps opening in its
  app, a finger on the draggable pin. The headless shell has no iOS keyboard. Chromium swallows taps
  for about a second after a fast flick even where nothing can scroll; the e2e rests its finger
  before lifting, so it does not see this.

