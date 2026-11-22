/**
 * The HTTP API of trip-diary: every request and response shape, shared by the server, the web
 * client and command-line clients.
 *
 * Conventions
 * - Times are ISO-8601 strings with an offset (`2026-10-17T14:05:00+02:00`); dates are `YYYY-MM-DD`.
 * - Coordinates are WGS84 degrees.
 * - Bodies are JSON. Errors are `ApiError` with the status below.
 * - Every response carries `X-Robots-Tag: noindex`.
 *
 * Authentication
 * - View: the trip's view token in the path, `/api/t/<viewToken>/…`. Tokens are 22 characters of
 *   base64url. A trip can have several, each labelled and revocable on its own.
 * - Edit: a view route on the editing host (`server.edit_url`), whose whole host sits behind the
 *   identity provider's login. The reverse proxy announces the logged-in address in
 *   `auth.identity_header` (oauth2-proxy's `X-Auth-Request-Email` by default); the app takes it as the editor when `auth.editor_from_header` is on and
 *   the address is in `auth.allowed_emails`, and then every live view token of every trip is
 *   editable. Every other host and route blanks the header. Writes must carry an `Origin` header
 *   equal to the editing origin. The app keeps no session of its own. Edit shares created
 *   earlier grant nothing.
 * - Admin: `Authorization: Bearer <admin token>` on `/api/admin/…`. Admin note and media routes
 *   are the edit routes under `/api/admin/trips/<slug>/…`, with the admin-only fields allowed.
 *
 * The app itself does not check where an admin request comes from: the reverse proxy must not
 * forward `/api/admin` from the internet (docs/security.md).
 *
 * Media come only from Immich: the app holds no uploads and reads Immich with a key that may only
 * read assets (and, optionally, list albums).
 *
 * Maps are a separate feature on the same server (`maps.enabled`, off by default; the meeting
 * point on them needs `meet.enabled` too): a map of people and places, reached through two
 * kinds of capability link and no account. See the map section at the end of this file.
 *
 * Status codes: 400 invalid body or parameter · 401 admin token missing or wrong · 403 not the
 * editor (or a foreign `Origin`) on a write, not the editor on a picker route, or a map's
 * view token on a map write · 404 unknown token, trip, note, media, map or entry (also for media
 * of another trip) · 409 conflict (a number or slug already taken, a day note that cannot be
 * deleted, the trip's note limit reached, an editor's view token revoked alone, the map's entry
 * limit reached, restoring an entry that is not deleted) ·
 * 412 `If-Match` revision mismatch · 413 body too large · 429 write or geocoder budget used up ·
 * 502 Immich or the geocoder failed.
 *
 * Routes
 *
 * Public
 *   GET  /healthz                                   → Health
 *   GET  /<viewToken>                               → the web app, with the TripView inlined
 *   GET  /m/<mapToken>                              → the map page, with the MapView inlined
 *
 * Editing host (the proxy puts the identity provider's login in front of the whole host)
 *   GET  /                                          → the editor: the list of trips as an HTML page,
 *                                                     each linking its view token, and the list of
 *                                                     maps, each linking its edit token, with a link
 *                                                     to the proxy's sign-out. 403 for an address
 *                                                     that may not edit. On any other host: 302 to
 *                                                     the editing host (404 while
 *                                                     `auth.editor_from_header` is off).
 *   GET  /<viewToken>                               → as on the public host, with the editable
 *                                                     TripView inlined for the editor.
 *
 * The editor's trip pages (editing host; HTML pages and HTML form posts, not JSON; for anyone but
 * the editor GET answers as `/` does and POST 403; every POST needs the editing `Origin`; a POST
 * answers 303 to the page to show next, or the form again with the problem and 400/409)
 *   GET  /trips/new                                 → the form for a new trip
 *   POST /trips/new                                 slug, title, short_title, timezone, start_date,
 *                                                     end_date (empty: open) → 303 to the new trip's
 *                                                     page. Makes the trip as TripCreate does, with
 *                                                     `extra.end_date`.
 *   GET  /trips/<slug>                              → the trip's settings and its read links
 *   POST /trips/<slug>                              title, short_title, timezone, start_date,
 *                                                     end_date (only for a trip that has one; empty:
 *                                                     open), first_day (the number day 1 shows:
 *                                                     `day_offset` + 1), hide_camps, delay_hours
 *                                                     → 303 to the settings
 *   POST /trips/<slug>/end                          → `extra.end_date` today in the trip's zone, 303
 *   POST /trips/<slug>/shares                       label → a new view share, 303
 *   POST /trips/<slug>/shares/<id>/revoke           → revokes a view share that is not an editor's,
 *                                                     303; 409 when it is the trip's last live view
 *                                                     link, as the trip could then not be opened.
 *
 * View (view token)
 *   GET  /api/t/<token>                             → TripView. `editable` is true for the editor
 *                                                     on the editing host. Sends an ETag; answers
 *                                                     304 to a matching If-None-Match.
 *   GET  /api/t/<token>/m/<mediaId>/<MediaSize>     → the bytes, proxied from Immich with
 *                                                     Range passthrough; `?v=<Media.v>` responses
 *                                                     are cacheable forever. `video` exists for
 *                                                     videos only.
 *
 * Picking photos (view token + the editor; reads, so no `Origin` is needed; 403 for anyone else)
 *   GET  /api/t/<token>/suggest                     as the admin's suggest: the Immich assets of a
 *                                                     time window within the trip's, for the
 *                                                     editor's photo picker.
 *   GET  /api/t/<token>/immich/<assetId>/thumb      → the asset's thumbnail, proxied from Immich,
 *                                                     whether or not a note carries it yet.
 *
 * Edit (view token + the editor), and the same under /api/admin/trips/<slug> (Bearer)
 *   POST   …/notes                                  NoteCreate → 201 Note; 200 with the note
 *                                                     already made for the same `client_id`
 *   GET    …/notes/<NoteKey>                        → Note
 *   PATCH  …/notes/<NoteKey>                        NotePatch → Note. Optional `If-Match: <rev>`:
 *                                                     412 with `ApiError.note` when it differs.
 *   DELETE …/notes/<NoteKey>                        → 204. Numbered notes only.
 *   POST   …/notes/<NoteKey>/media                  MediaAttach (an Immich asset) → 201 Media.
 *                                                     409 when the note carries it already.
 *   PATCH  …/notes/<NoteKey>/media/<mediaId>        MediaPatch → Media
 *   DELETE …/notes/<NoteKey>/media/<mediaId>        → 204
 *
 * Admin (Bearer)
 *   GET    /api/admin/trips                         → TripSummary[]
 *   POST   /api/admin/trips                         TripCreate → 201 TripCreated
 *   GET    /api/admin/trips/<slug>                  → TripAdminView
 *   PATCH  /api/admin/trips/<slug>                  TripPatch → Trip
 *   GET    /api/admin/trips/<slug>/shares           → Share[]
 *   POST   /api/admin/trips/<slug>/shares           ShareCreate → 201 ShareCreated
 *   DELETE /api/admin/trips/<slug>/shares/<id>      → 204 (revokes; the row stays). Revoking an
 *                                                     earlier edit share revokes its view token
 *                                                     too; an editor's view token alone answers 409.
 *   PUT    /api/admin/trips/<slug>/days/<n>         DayPut → Day. Creates the day's day-end
 *                                                     note when it does not exist yet.
 *   DELETE /api/admin/trips/<slug>/days/<n>         → 204. 409 while its day-end note has text
 *                                                     or media.
 *   PUT    /api/admin/trips/<slug>/waypoints        WaypointsPut → Waypoint[] (replaces all)
 *   GET    /api/admin/trips/<slug>/suggest          ?from=<Iso>&to=<Iso> (default: the trip's
 *                                                     track span, an hour either side) → Suggestion[],
 *                                                     oldest first: the key's own and its partners'
 *                                                     assets and, when the key has album.read, those
 *                                                     of albums shared with it, each once, none in
 *                                                     Immich's trash. Clamped to
 *                                                     the trip's window, 12 h either side: the span
 *                                                     of its tracks, its notes' anchors, start_date
 *                                                     and its days' dates.
 *   GET    /api/admin/trips/<slug>/m/<mediaId>/<MediaSize>
 *                                                   → the bytes, as the view route.
 */

/** ISO-8601 date-time with offset. */
export type Iso = string;

/** A note's address: its number (`"7"`) for a numbered note, `d<day>` (`"d3"`) for a day-end note. */
export type NoteKey = string;

export interface Health {
  ok: true;
  version: string;
}

export interface ApiError {
  error: string;
  /** The current note, on a 412. */
  note?: Note;
  /** The current map entry, on a 412. */
  entry?: Entry;
}

// ---------------------------------------------------------------- trips

export interface Trip {
  /** Stable handle used by admin routes, e.g. `summer-walk`. */
  slug: string;
  title: string;
  /** Shown where the title does not fit (the first card of the top strip). */
  short_title: string | null;
  /** IANA zone the trip is displayed in, e.g. `Europe/Berlin`. */
  timezone: string;
  start_date: string | null;
  /**
   * Fields the app keeps for other tools; empty in views that are not editable. The editor's pages
   * set `end_date`: the trip's last day (`YYYY-MM-DD`) or `open`, for a job that imports a trip's
   * days while it lasts.
   */
  extra: Record<string, unknown>;
  privacy: TripPrivacy;
  /** Added to every day number shown: -1 shows day 1 as "Tag 0", -2 its first two days as "Tag -1" and "Tag 0". Routes, note keys (`d3`) and `Day.n` keep the stored number. */
  day_offset: number;
}

/** What view links hold back. Editors and admin always see everything. */
export interface TripPrivacy {
  /** Day ends show no camp type and no camp name. */
  hide_camps: boolean;
  /** Numbered notes created less than this many hours ago are left out. 0: none. */
  delay_hours: number;
}

export interface TripView {
  trip: Trip;
  days: Day[];
  waypoints: Waypoint[];
  /** Numbered and day-end notes, in timeline order (see `Anchor`). */
  notes: Note[];
  editable: boolean;
  /** Increases with every write to the trip. */
  rev: number;
  /** Editable views: the read link to hand out (the newest live view share that is not an editor's). Null otherwise, or when there is none. */
  share_url: string | null;
  /** Editable views: the path on the editing host that ends the proxy's session (`auth.sign_out_path`). Null otherwise. */
  sign_out_path: string | null;
}

export interface TripAdminView extends TripView {
  shares: Share[];
}

export interface TripSummary {
  slug: string;
  title: string;
  days: number;
  notes: number;
  media: number;
  rev: number;
}

export interface TripCreate {
  slug: string;
  title: string;
  short_title?: string | null;
  timezone: string;
  start_date?: string | null;
  extra?: Record<string, unknown>;
  /** Default: nothing held back. */
  privacy?: Partial<TripPrivacy>;
  /** An integer from -99 to 99. Default 0. */
  day_offset?: number;
}

export type TripPatch = Partial<Omit<TripCreate, "slug">>;

/** A new trip comes with a view share to hand out (label `friends`). */
export interface TripCreated {
  trip: Trip;
  view: ShareCreated;
}

// ---------------------------------------------------------------- shares

/** `edit` only on shares created before editing moved to the login; new ones are always `view`. */
export type ShareRole = "view" | "edit";

export interface Share {
  id: number;
  role: ShareRole;
  label: string;
  created: Iso;
  revoked_at: Iso | null;
  /** The read-only link of a view share to hand out. Null for an earlier edit share, whose token is not stored, and for an editor's view token. */
  url: string | null;
  /** A view share an earlier edit share is built on: never handed out, revoked together with that edit share. */
  editor: boolean;
  /** An earlier edit share's view share; null for view shares. */
  base: number | null;
}

export interface ShareCreate {
  /** Only `view`; `edit` answers 400. */
  role: "view";
  label: string;
}

export interface ShareCreated extends Share {
  token: string;
  /** `<public_url>/<viewToken>`. */
  url: string;
}

// ---------------------------------------------------------------- days and waypoints

/** `[lat, lon, elevation m, time]` */
export type TrackPoint = [lat: number, lon: number, ele: number | null, time: Iso];

/** The recording's own summary; never recomputed from the (thinned) track. */
export interface DayStats {
  km: number;
  ascent_m: number;
  descent_m: number;
  start_time: Iso;
  end_time: Iso;
  moving_time_min: number;
  elapsed_time_min: number;
  min_ele: number;
  max_ele: number;
  [extra: string]: unknown;
}

export type CampType = "wild" | "nature" | "trekking";

/** Where the day ended: the camp. */
export interface DayEnd {
  lat: number;
  lon: number;
  camp_type: CampType | null;
  name: string | null;
  osm?: string | null;
}

export interface Day {
  n: number;
  date: string;
  /** In time order. Empty for a rest day. */
  track: TrackPoint[];
  /**
   * Indices into `track` where a new recording starts (ridden, then a train, then ridden again): the
   * stretch from `track[i - 1]` to `track[i]` was not travelled under its own power. The map draws it
   * as a thin dashed line; anchors never snap to it and it adds nothing to the kilometres along the
   * day. Strictly increasing, each between 1 and `track.length - 1`. Absent or empty: one recording.
   */
  breaks?: number[];
  stats: DayStats | null;
  end: DayEnd | null;
  /** Where the day came from, e.g. `{garmin_activity_id}`. */
  source: Record<string, unknown> | null;
}

export type DayPut = Omit<Day, "n">;

/** A planned point actually passed: water, tap, toilet, shop… Drawn on the map, not in the timeline. */
export interface Waypoint {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  day: number | null;
  passed_time: Iso | null;
  notes: string | null;
}

export type WaypointsPut = Waypoint[];

// ---------------------------------------------------------------- notes

export type NoteKind = "note" | "day";

/**
 * Where a note sits in the timeline.
 * - `track`: the time of the nearest point on the tracks (interpolated within a segment; the gaps
 *   between a day's recordings, `Day.breaks`, are no segments). Where
 *   the tracks pass the spot more than once, the earliest pass wins, unless the note's earliest
 *   media `taken_at` picks the pass nearest in time to it.
 * - `at`: the note's manual `at`; always for a note without a place.
 * - `created`: the note lies more than 300 m from every track and was created after the last
 *   track point — placed on a day whose track is not recorded yet.
 * - `day-end`: a day-end note, at its day's last track point.
 * - `rest-day`: a day-end note of a day without a track, at 18:00 local time on its date.
 * Ties order by time, then numbered notes before day-end notes, then number.
 */
export type AnchorRule = "track" | "at" | "created" | "day-end" | "rest-day";

export interface Anchor {
  t: Iso;
  rule: AnchorRule;
  /** The day the note belongs to; null only when the trip has no days. */
  day: number | null;
  /** Distance to the nearest track point, metres; null when the trip has no track. */
  dist_m: number | null;
  /** Kilometres into `day` at the anchor, when the anchor lies on that day's track. */
  km: number | null;
  /** More than 300 m from every track. */
  off_track: boolean;
}

export interface Note {
  key: NoteKey;
  kind: NoteKind;
  /** Stable once given; deleting a note leaves a gap. Null for day-end notes. */
  number: number | null;
  /** The day of a day-end note; null for numbered notes (their day is `anchor.day`). */
  day: number | null;
  /** A day-end note's position is its day's end. Null for a numbered note without a place: it
   * stands in the timeline by its `at` only and has no pin on the map. */
  lat: number | null;
  lon: number | null;
  /** May be empty. A day-end note without a title shows its camp name. */
  title: string;
  /** Markdown. */
  text: string;
  created: Iso;
  updated: Iso;
  /** Increases with every change to the note or its media. */
  rev: number;
  at: Iso | null;
  /** Fields carried over from elsewhere that the app does not interpret. */
  extra: Record<string, unknown>;
  /** In display order. */
  media: Media[];
  anchor: Anchor;
}

export interface NoteCreate {
  /** Position, or `from_asset` instead. Both null: a note without a place, at `at` (default:
   * `created`). */
  lat?: number | null;
  lon?: number | null;
  /** Admin only. An Immich asset id: the note goes to the asset's GPS position, or, without one,
   * to the track position at its capture time; the asset is attached. */
  from_asset?: string;
  title?: string;
  text?: string;
  at?: Iso | null;
  /** Admin only: an explicit number (409 when taken). Default: highest number + 1. */
  number?: number;
  /** Default: now. Editors may send a time up to 7 days back (a placement queued while offline); admin any. */
  created?: Iso;
  /** Admin only. */
  extra?: Record<string, unknown>;
  /** Any id the client chose for this placement (≤ 64 characters). A retry with the same id answers with the note the first request made. */
  client_id?: string;
}

export interface NotePatch {
  /** Numbered notes only. Both null takes the place away; a note without `at` then gets its
   * current anchor time as `at`, so it keeps its spot in the timeline. */
  lat?: number | null;
  lon?: number | null;
  title?: string;
  text?: string;
  /** Null on a note without a place answers 400: it stands only by its time. */
  at?: Iso | null;
  /** Admin only; replaces the whole object. */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------- media

export type MediaType = "image" | "video";
/** `thumb` ≈ 250 px, `preview` ≈ 1440 px, `video` the playable stream. */
export type MediaSize = "thumb" | "preview" | "video";

export interface Media {
  id: number;
  type: MediaType;
  caption: string | null;
  position: number;
  taken_at: Iso | null;
  lat: number | null;
  lon: number | null;
  /** Of the preview, orientation applied. */
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** Changes when the underlying image changes; part of every URL below. */
  v: string;
  /** Same-origin URLs including `?v=`. `video` is null for images. */
  thumb: string;
  preview: string;
  video: string | null;
  /** Editable and admin views only. */
  immich_id?: string | null;
  /** Editable and admin views only: when Immich last reported the asset trashed or gone. Such media are left out of other views. */
  unavailable_at?: Iso | null;
}

export interface MediaAttach {
  immich_id: string;
  caption?: string | null;
  /** 0-based index within the note. Default: after the last. */
  position?: number;
}

export interface MediaPatch {
  caption?: string | null;
  /** Moves the medium to this 0-based index within its note; past the end means last. */
  position?: number;
}

/** An Immich asset in the requested window, with where it would fit. */
export interface Suggestion {
  immich_id: string;
  type: MediaType;
  taken_at: Iso;
  lat: number | null;
  lon: number | null;
  duration_ms: number | null;
  /** Notes of this trip that already carry it. */
  attached_to: NoteKey[];
  /** Nearest note by position (GPS assets only). */
  nearest_note: { key: NoteKey; dist_m: number } | null;
  /** The track position at `taken_at`, interpolated. */
  track: { day: number; lat: number; lon: number } | null;
}

// ---------------------------------------------------------------- maps

/*
 * A map holds entries (a person, a couple, a household, anything with a name), each with any
 * number of places. Anyone with the edit link changes everything; nobody has an account.
 *
 * Authentication: a map token in the path, 22 characters of base64url. A `view` token reads, an
 * `edit` token reads and writes; a view token on a write answers 403. No cookie is involved. An
 * edit token has `maps.writes_per_minute` writes, 429 above; admin routes have no budget.
 *
 * Routes
 *
 * View (either token)
 *   GET    /api/m/<token>                           → MapView. Sends an ETag; answers 304 to a
 *                                                     matching If-None-Match.
 *   GET    /api/m/<token>/geocode?q=<text>[&lat&lon] → GeoHit[] (at most 6, near lat/lon when
 *                                                     given). 400 for q shorter than 3 characters,
 *                                                     429 over the budget, 502 geocoder failed.
 *   GET    /api/m/<token>/geocode?lat=<n>&lon=<n>   → GeoHit[] (0 or 1): the address at a point.
 *   GET    /api/m/<token>/meet                      → MeetState (also in MapView.meet)
 *   GET    /api/m/<token>/avatar/<id>               → the picture; its URL never changes content.
 *
 * Link preview (no token; the map's own preview id, 32 hex characters, which grants this picture and
 * nothing else, and which revoking a share replaces)
 *   GET    /preview/<id>.jpg?v=<rev>                → a 1200 px square JPEG: the base map of
 *                                                     Central Europe with a disc for every place of
 *                                                     the map's live entries in that section (the
 *                                                     entry's picture, else its colour). Always the
 *                                                     map's current state, whatever `v` says; `v` only
 *                                                     keeps caches apart. 404 for an unknown id. The
 *                                                     page's Open Graph tags point here, or at
 *                                                     /assets/map-fallback.jpg for a map with no place
 *                                                     in the section; a picture that cannot be
 *                                                     composed answers with that generic one.
 *
 * Edit (edit token), and the same under /api/admin/maps/<slug> (Bearer)
 *   POST   …/entries                               EntryCreate → 201 Entry; 200 with the entry
 *                                                     already made for the same `client_id`; 409 at
 *                                                     the map's entry limit (deleted ones count
 *                                                     until they are purged). A retry for an entry
 *                                                     deleted meanwhile brings it back.
 *   GET    …/entries/<id>                           → Entry, deleted ones too
 *   PATCH  …/entries/<id>                           EntryPatch → EntryWritten. Brings a deleted
 *                                                     entry back (`revived`). Optional
 *                                                     `If-Match: <rev>`: 412 with `ApiError.entry`
 *                                                     when it differs; the web client sends none,
 *                                                     there the latest write wins.
 *   DELETE …/entries/<id>?by=<name>                 → EntryWritten, `deleted_at` set. The entry stays
 *                                                     restorable for `maps.trash_days`; 404 when it
 *                                                     is deleted already.
 *   POST   …/entries/<id>/restore                   EntryRestore → Entry. Without `rev`: undeletes,
 *                                                     409 when it is not deleted. With `rev`: puts
 *                                                     that history state back, undeleting if needed;
 *                                                     404 for an unknown rev.
 *   GET    …/entries/<id>/history                   → EntryRev[], newest first
 *   DELETE …/entries/<id>/purge                     → 204: a deleted entry gone for good, history
 *                                                     included. On an edit token only together with
 *                                                     the editor (the login), else 403; 409
 *                                                     when the entry is not deleted.
 *   PUT    …/entries/<id>/avatar                    body: the image, Content-Type image/jpeg, png
 *                                                     or webp → EntryWritten. 400 larger than
 *                                                     `limits.avatar_px`, 413 over `limits.avatar_bytes`,
 *                                                     415 another format, 429 over `maps.avatar_per_minute`.
 *   DELETE …/entries/<id>/avatar                    → EntryWritten
 *   PUT    …/meet/members/<entryId>                 MeetMemberPut → MeetState. In the selection from
 *                                                     then on; a new member is weight 1, by car. 400
 *                                                     for an entry without a place or an unknown place.
 *   DELETE …/meet/members/<entryId>                 → MeetState
 *   POST   …/meet/compute                           → 202 MeetState with `job`, for everyone. 400 under
 *                                                     two members, 409 while a job runs. A failing job
 *                                                     ends with `job.error`, the old result stays.
 *
 * Admin (Bearer)
 *   GET    /api/admin/maps                          → MapSummary[]
 *   POST   /api/admin/maps                          MapCreate → 201 MapCreated
 *   GET    /api/admin/maps/<slug>                   → MapAdminView
 *   PATCH  /api/admin/maps/<slug>                   MapPatch → MapInfo
 *   DELETE /api/admin/maps/<slug>                   → 204, with everything on the map
 *   GET    /api/admin/maps/<slug>/geocode           as the view route
 *   GET    /api/admin/maps/<slug>/shares            → MapShare[]
 *   POST   /api/admin/maps/<slug>/shares            MapShareCreate → 201 MapShareCreated
 *   DELETE /api/admin/maps/<slug>/shares/<id>       → 204 (revokes; the row stays)
 */

/** Reserved: nothing is configurable per map yet. */
export type MapSettings = Record<string, never>;

export interface MapInfo {
  /** Stable handle used by admin routes. */
  slug: string;
  title: string;
  settings: MapSettings;
}

export interface Place {
  /** Stable while the entry is edited. */
  id: string;
  /** What the place is to the entry, e.g. `Zuhause`. May be empty. */
  label: string;
  /** May be empty. */
  address: string;
  lat: number;
  lon: number;
}

/** A place in a request: an `id` is kept when given, else assigned. */
export type PlaceInput = Omit<Place, "id"> & { id?: string };

export interface Entry {
  id: number;
  name: string;
  /** One emoji shown instead of the initials. */
  emoji: string | null;
  /** Index into the client's palette, 0–9. */
  color: number;
  /** Plain text. */
  note: string;
  places: Place[];
  created: Iso;
  updated: Iso;
  /** Increases with every change to the entry. */
  rev: number;
  /** The name the last writer gave, unverified. */
  by: string | null;
  deleted_at: Iso | null;
  /** The picture's id: `…/avatar/<id>`. Shown instead of the emoji and the initials. */
  avatar: string | null;
}

/** An entry after a write. */
export interface EntryWritten extends Entry {
  /** The history row holding the state before this write: `restore` with it undoes the write. */
  undo_rev: number;
  /** Set on a PATCH: the entry was deleted, and this write brought it back. */
  revived?: boolean;
}

export interface EntryCreate {
  name: string;
  emoji?: string | null;
  /** Default: the colour after the highest one the map uses. */
  color?: number;
  note?: string;
  places?: PlaceInput[];
  by?: string | null;
  /** Any id the client chose for this entry (≤ 64 characters). A retry with the same id answers with the entry the first request made. */
  client_id?: string;
}

export interface EntryPatch {
  name?: string;
  emoji?: string | null;
  color?: number;
  note?: string;
  /** Replaces all places. */
  places?: PlaceInput[];
  /** Only null: takes the picture away. A picture itself goes through its own route. */
  avatar?: null;
  by?: string | null;
}

export interface EntryRestore {
  rev?: number;
  by?: string | null;
}

export type EntryAction = "create" | "update" | "delete" | "restore";

export interface EntryRev {
  id: number;
  at: Iso;
  by: string | null;
  action: EntryAction;
  /** The entry before this change; for `create`, the new entry. */
  snapshot: Entry;
}

export interface MapView {
  map: MapInfo;
  /** Alphabetical, those without a place last, without deleted ones. */
  entries: Entry[];
  /** True for an edit token. */
  editable: boolean;
  /** Increases with every write to the map. */
  rev: number;
  /** Edit tokens: the read link to hand out (the newest live view share). Null otherwise, or when there is none. */
  view_url: string | null;
  /** Edit tokens: the deleted entries, newest first. Empty otherwise. */
  trash: Entry[];
  /** True when this request may delete trashed entries for good: an edit token on the editing host, or the admin. */
  can_purge: boolean;
  meet: MeetState;
  /** False when the meeting point is switched off (`meet.enabled`): the page shows no button for it. */
  meet_enabled: boolean;
}

export interface MapShare {
  id: number;
  role: "view" | "edit";
  label: string;
  created: Iso;
  revoked_at: Iso | null;
  /** `<public_url>/m/<token>`. */
  url: string;
}

export interface MapShareCreate {
  role: "view" | "edit";
  label: string;
}

export interface MapShareCreated extends MapShare {
  token: string;
}

export interface MapAdminView extends MapView {
  shares: MapShare[];
}

export interface MapSummary {
  slug: string;
  title: string;
  /** Without deleted ones. */
  entries: number;
  rev: number;
}

export interface MapCreate {
  slug: string;
  title: string;
  settings?: MapSettings;
}

export type MapPatch = Partial<Omit<MapCreate, "slug">>;

/** A new map comes with a read link and a write link. */
export interface MapCreated {
  map: MapInfo;
  view: MapShareCreated;
  edit: MapShareCreated;
}

/** One geocoder result. */
export interface GeoHit {
  /** One line, e.g. `Musterweg 7, 30163 Hannover`. */
  label: string;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
  google_url: string;
}

// ---------------------------------------------------------------- the meeting point

export type MeetMode = "car" | "train";

/** An entry in the selection. */
export interface MeetMember {
  entry_id: number;
  /** How many people the entry stands for, 1–4. */
  weight: number;
  mode: MeetMode;
  /** Null: the entry's first place. */
  place_id: string | null;
  updated: Iso;
}

export interface MeetMemberPut {
  weight?: number;
  mode?: MeetMode;
  place_id?: string | null;
}

export interface MeetStation {
  name: string;
  eva: string;
  lat: number;
  lon: number;
}

/** One member's way to a candidate. */
export interface MeetLeg {
  entry_id: number;
  /** Null: no way found. */
  minutes: number | null;
  /** What the number is; `car-fallback` for a train member without a train. */
  by: "car" | "train" | "car-fallback";
  /** The home station of a train member. */
  station: string | null;
  /** The car ride to that station; 0 within `meet.station_radius_km`. */
  access_min: number;
}

export interface MeetCandidate {
  station: MeetStation;
  /** The sum of weight × minutes²: lowest wins. */
  score: number;
  /** Weighted mean minutes. */
  mean_min: number;
  max_min: number;
  legs: MeetLeg[];
}

/** The state a result was computed from. */
export interface MeetBasis {
  entry_id: number;
  name: string;
  weight: number;
  mode: MeetMode;
  lat: number;
  lon: number;
}

export interface MeetResult {
  computed_at: Iso;
  /** The departure train times are for. */
  departure: Iso;
  based_on: MeetBasis[];
  /** Best first, at most three. */
  candidates: MeetCandidate[];
  /** False: the train service failed and everybody counts by car. */
  train_ok: boolean;
  notes: string[];
}

export interface MeetJob {
  started: Iso;
  done: number;
  total: number;
  /** Set when the job failed; cleared by the next one. */
  error: string | null;
}

export interface MeetState {
  /** Live entries only. */
  members: MeetMember[];
  /** The straight-line weighted middle; null under two members. */
  centroid: { lat: number; lon: number } | null;
  /** The last result, even when it is out of date. */
  result: MeetResult | null;
  /** The selection differs from what the result was computed from. */
  stale: boolean;
  /** A running job, or a failed last one. */
  job: MeetJob | null;
}
