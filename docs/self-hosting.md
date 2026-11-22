# Self-hosting

What the app needs around it, how the login is wired and how to check that wiring. The runnable
example is [examples/](examples/): `compose.yaml`, a `Caddyfile` and `.env.example`.

## The pieces

```
browser ──► Caddy ──► trip.example.org       ──► trip-diary   (view links, read-only)
               └────► trip-edit.example.org  ──► oauth2-proxy ──► OIDC provider
                                                    └─ approved ─► trip-diary   (the editor)
trip-diary ──► Immich (photos and videos, read-only key)
```

- **Two hostnames, one app.** The public host (`server.public_url`) serves view links and can
  never edit. The editing host (`server.edit_url`) is the only place a request can be the
  editor's. A browser's draft notes and queued placements live per origin, so they stay on the host
  where they were made.
- **The login is the proxy's.** The app keeps no session, cookie or password. The proxy puts an
  identity provider's login in front of the whole editing host and tells the app who logged in
  through a request header. Any provider oauth2-proxy speaks to works (Zitadel, Authentik,
  Keycloak, Google, GitHub, …); so do Authelia, Authentik's outpost or Traefik forward-auth, with
  the header name set in `auth.identity_header` and the sign-out path in `auth.sign_out_path`.
- **A login alone grants nothing.** The address must also be listed in `auth.allowed_emails`, so
  an identity provider that lets anyone register does not make everyone an editor.

## The proxy contract

The app takes a request as the editor's when all of these hold:

- `auth.editor_from_header` is on;
- the request's `Host` is the host of `server.edit_url`;
- the header named by `auth.identity_header` holds an address from `auth.allowed_emails`
  (compared without case).

Writes must also carry an `Origin` equal to `server.edit_url`. That is safe only when the proxy:

- forces a login on the whole editing host and overwrites the identity header with its own answer
  (never passes the client's);
- strips the identity header on every other host and route;
- is the only way to reach the app: publishing the app's port to the internet lets anybody send
  the header themselves. Keep it on an internal network, or bind it to `127.0.0.1`.

The example Caddyfile does this: `forward_auth` copies the header from oauth2-proxy's answer
(replacing what the client sent), and the public host removes it.

### Probes

Run these after any proxy change (host names as in the example):

```bash
# A forged header on the public host must not make the view editable: expect "editable":false
curl -s -H 'X-Auth-Request-Email: you@example.org' https://trip.example.org/<view token> | grep -o '"editable":[a-z]*'

# The editing host without a login must redirect to the sign-in
curl -sI https://trip-edit.example.org/ | head -1

# The admin API must answer 403 from outside, in every spelling
for p in /api/admin/trips //api/admin/trips /api/admin/./trips /x/%2e%2e/api/admin/trips; do
  curl -s --path-as-is -o /dev/null -w "$p %{http_code}\n" https://trip.example.org$p
done
```

## Immich

- **Key:** an API key with `asset.read` and `asset.view`. The app only reads: asset metadata, the
  time-window search, thumbnails, previews and video playback. Some Immich versions may want
  `asset.download` for video playback too; add it if videos do not play.
- **Whose library:** the key sees its owner's whole library, and the editor can attach any asset
  of it (the photo picker and `trip media attach`). Create a dedicated Immich user for the key, and
  put into its library only what you are willing to put in a diary, for instance through partner
  sharing or shared albums.
- **Reachability:** `immich.url` is how the app container reaches Immich (a service name on a
  shared Docker network works). Browsers never talk to Immich: the app proxies every image and
  video.
- **Version:** developed against a current Immich release; older ones are untested.
- **Removed media:** a photo trashed or deleted in Immich disappears from view links within
  `immich.sweep_minutes`; browsers that cached it keep their copy.

## The admin API

`/api/admin/…` is guarded by a bearer token (`ADMIN_TOKEN`) and does not check where a request
comes from. Do not forward it from the internet: both hosts in the example Caddyfile answer 403
for it. Reach it from the machine the app runs on, as the example compose file publishes the port
on `127.0.0.1` only, and use the [`trip` command](cli.md).

Generate the token long and random (`openssl rand -hex 32`). View tokens in a URL are read links
for one trip and the admin token is everything: keep both out of logs and chat.

## Configuration

Every option, its default and its meaning is in [`config/config.yaml`](../config/config.yaml). Any
value can be overridden with `TRIP_<SECTION>_<KEY>` (for example `TRIP_MAPS_ENABLED=true`).
Besides those, `ADMIN_TOKEN` and `IMMICH_API_KEY` are read from the environment.

The app refuses to start while `server.public_url` or `immich.url` still holds an example host,
and while `server.edit_url` does with the header login on. Maps and the meeting point are off
until `maps.enabled` and `meet.enabled` say otherwise (the meeting point needs the maps).

## Data, backups and upgrades

- **Data:** one SQLite file, `trip.db` in `data.dir` (`/data` in the image, WAL mode), and
  nothing else. The photos stay in Immich. The container runs as uid 1000, so a bind-mounted
  `/data` must be writable by it.
- **Backup:** copy the file while the app runs with `sqlite3 trip.db ".backup backup.db"`, or stop
  the container and copy `trip.db` together with `trip.db-wal` and `trip.db-shm` if they exist.
- **Upgrade:** pull the new image tag and restart. Schema migrations run at start and are
  one-way: keep a backup before a minor release, and read the changelog. Going back to an older
  image after a migration needs the backup.
- **Images:** `ghcr.io/frederikberg/trip-diary`, tagged by version and `latest`, `linux/amd64`
  only.

## Third-party services

- The trip map uses OpenTopoMap tiles (volunteer-run, fair use; attribution stays in the map).
- The maps page uses OpenFreeMap tiles and, for address search, a Photon geocoder
  (`maps.geocoder_url`). The browser fetches tiles directly.
- The meeting point asks OSRM for car times and an unofficial DB Navigator endpoint for train
  times. Both are best effort, the demo OSRM server forbids commercial use, and the DB endpoint is
  undocumented and may change or vanish. That is why it is off by default.
