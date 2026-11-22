// SQLite storage: schema migrations and row access. WAL mode keeps the file crash-consistent, so
// a volume snapshot of the data directory is a valid backup.

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Day, EntryAction, MediaType, MeetMode, NoteKind, ShareRole, Waypoint } from "../shared/api";

export const MIGRATIONS = [
  `CREATE TABLE trip (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     short_title TEXT,
     timezone TEXT NOT NULL,
     start_date TEXT,
     created TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1,
     extra TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE share (
     id INTEGER PRIMARY KEY,
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
     label TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     token TEXT,
     created TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE TABLE day (
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     n INTEGER NOT NULL,
     date TEXT NOT NULL,
     track TEXT NOT NULL,
     stats TEXT,
     end_point TEXT,
     source TEXT,
     PRIMARY KEY (trip_id, n)
   );
   CREATE TABLE waypoint (
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     lat REAL NOT NULL,
     lon REAL NOT NULL,
     day INTEGER,
     passed_time TEXT,
     notes TEXT,
     PRIMARY KEY (trip_id, id)
   );
   CREATE TABLE note (
     id INTEGER PRIMARY KEY,
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('note', 'day')),
     number INTEGER,
     day_n INTEGER,
     lat REAL,
     lon REAL,
     title TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     created TEXT NOT NULL,
     updated TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1,
     at TEXT,
     extra TEXT NOT NULL DEFAULT '{}',
     UNIQUE (trip_id, number),
     UNIQUE (trip_id, day_n),
     CHECK ((kind = 'note' AND number IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL) OR (kind = 'day' AND day_n IS NOT NULL))
   );
   CREATE TABLE media (
     id INTEGER PRIMARY KEY,
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('immich', 'local')),
     immich_id TEXT,
     file TEXT,
     type TEXT NOT NULL CHECK (type IN ('image', 'video')),
     caption TEXT,
     taken_at TEXT,
     lat REAL,
     lon REAL,
     width INTEGER,
     height INTEGER,
     duration_ms INTEGER,
     v TEXT NOT NULL,
     created TEXT NOT NULL
   );
   CREATE INDEX media_note ON media (note_id, position);`,
  // An edit share's view token (`base_id`, marked `editor`) is never handed out; an edit share
  // without one takes the trip's oldest live view share. Media availability and sizes;
  // per-trip privacy settings.
  `ALTER TABLE share ADD COLUMN editor INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE share ADD COLUMN base_id INTEGER REFERENCES share(id);
   UPDATE share SET base_id = (
     SELECT v.id FROM share v WHERE v.trip_id = share.trip_id AND v.role = 'view' AND v.revoked_at IS NULL ORDER BY v.id LIMIT 1
   ) WHERE role = 'edit';
   UPDATE share SET editor = 1 WHERE id IN (SELECT base_id FROM share WHERE role = 'edit' AND base_id IS NOT NULL);
   ALTER TABLE media ADD COLUMN unavailable_at TEXT;
   ALTER TABLE media ADD COLUMN bytes INTEGER;
   ALTER TABLE note ADD COLUMN client_id TEXT;
   CREATE UNIQUE INDEX note_client ON note (trip_id, client_id) WHERE client_id IS NOT NULL;
   ALTER TABLE trip ADD COLUMN privacy TEXT NOT NULL DEFAULT '{}';`,
  // Editor sessions (the owner's login); only the hash of the cookie token is stored.
  `CREATE TABLE session (
     id INTEGER PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     email TEXT NOT NULL,
     created TEXT NOT NULL,
     last_used TEXT NOT NULL,
     expires TEXT NOT NULL
   );`,
  // Maps of people and places. `entry.places` is JSON: an entry is edited as one unit. Tokens of
  // both roles stay readable, because the admin lists the links.
  `CREATE TABLE map (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     created TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1,
     settings TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE map_share (
     id INTEGER PRIMARY KEY,
     map_id INTEGER NOT NULL REFERENCES map(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
     label TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     token TEXT NOT NULL,
     created TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE TABLE entry (
     id INTEGER PRIMARY KEY,
     map_id INTEGER NOT NULL REFERENCES map(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     emoji TEXT,
     color INTEGER NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     places TEXT NOT NULL DEFAULT '[]',
     created TEXT NOT NULL,
     updated TEXT NOT NULL,
     updated_by TEXT,
     rev INTEGER NOT NULL DEFAULT 1,
     deleted_at TEXT,
     client_id TEXT
   );
   CREATE UNIQUE INDEX entry_client ON entry (map_id, client_id) WHERE client_id IS NOT NULL;
   CREATE INDEX entry_map ON entry (map_id, deleted_at);
   CREATE TABLE entry_rev (
     id INTEGER PRIMARY KEY,
     entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by TEXT,
     action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
     snapshot TEXT NOT NULL
   );
   CREATE INDEX entry_rev_entry ON entry_rev (entry_id, id);`,
  // Avatars are content-addressed per map. The meeting point: who is in, the last result, and a
  // cache of travel times (`minutes` NULL: no connection).
  `ALTER TABLE entry ADD COLUMN avatar TEXT;
   CREATE TABLE avatar (
     map_id INTEGER NOT NULL REFERENCES map(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp')),
     bytes BLOB NOT NULL,
     created TEXT NOT NULL,
     PRIMARY KEY (map_id, id)
   );
   CREATE TABLE meet_member (
     map_id INTEGER NOT NULL REFERENCES map(id) ON DELETE CASCADE,
     entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
     weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 4),
     mode TEXT NOT NULL CHECK (mode IN ('car', 'train')),
     place_id TEXT,
     updated TEXT NOT NULL,
     PRIMARY KEY (map_id, entry_id)
   );
   CREATE TABLE meet_result (
     map_id INTEGER PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE,
     inputs_hash TEXT NOT NULL,
     result TEXT NOT NULL
   );
   CREATE TABLE travel_time (
     mode TEXT NOT NULL CHECK (mode IN ('car', 'train')),
     from_key TEXT NOT NULL,
     to_key TEXT NOT NULL,
     minutes INTEGER,
     at TEXT,
     fetched TEXT NOT NULL,
     PRIMARY KEY (mode, from_key, to_key)
   );`,
  // The link preview's picture has an id of its own: neither a view nor an edit token.
  `ALTER TABLE map ADD COLUMN preview_id TEXT;
   UPDATE map SET preview_id = lower(hex(randomblob(16)));
   CREATE UNIQUE INDEX map_preview_id ON map (preview_id);`,
  // Editing is the reverse proxy's login; the app keeps no sessions of its own.
  `DROP TABLE session;`,
  // A numbered note may stand without a place, by its time alone. SQLite cannot change a CHECK in
  // place, so the table is rebuilt; media keep pointing at the same note ids.
  `CREATE TABLE note_new (
     id INTEGER PRIMARY KEY,
     trip_id INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('note', 'day')),
     number INTEGER,
     day_n INTEGER,
     lat REAL,
     lon REAL,
     title TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     created TEXT NOT NULL,
     updated TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1,
     at TEXT,
     extra TEXT NOT NULL DEFAULT '{}',
     client_id TEXT,
     UNIQUE (trip_id, number),
     UNIQUE (trip_id, day_n),
     CHECK (
       (kind = 'note' AND number IS NOT NULL AND (
         (lat IS NOT NULL AND lon IS NOT NULL) OR (lat IS NULL AND lon IS NULL AND at IS NOT NULL)))
       OR (kind = 'day' AND day_n IS NOT NULL))
   );
   INSERT INTO note_new (id, trip_id, kind, number, day_n, lat, lon, title, text, created, updated, rev, at, extra, client_id)
     SELECT id, trip_id, kind, number, day_n, lat, lon, title, text, created, updated, rev, at, extra, client_id FROM note;
   DROP TABLE note;
   ALTER TABLE note_new RENAME TO note;
   CREATE UNIQUE INDEX note_client ON note (trip_id, client_id) WHERE client_id IS NOT NULL;`,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  // Migrations run with foreign keys off, so rebuilding a table does not cascade into the rows
  // pointing at it; each one must leave every reference intact.
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string);
      const broken = db.query("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error(`migration ${v + 1} broke references: ${JSON.stringify(broken.slice(0, 5))}`);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export interface TripRow {
  id: number;
  slug: string;
  title: string;
  short_title: string | null;
  timezone: string;
  start_date: string | null;
  created: string;
  rev: number;
  extra: string;
  /** JSON `TripPrivacy`. */
  privacy: string;
}

export interface ShareRow {
  id: number;
  trip_id: number;
  role: ShareRole;
  label: string;
  token_hash: string;
  token: string | null;
  created: string;
  revoked_at: string | null;
  /** 1 for the view share an edit link is built on. */
  editor: number;
  /** An edit share's view share. */
  base_id: number | null;
}

export interface NoteRow {
  id: number;
  trip_id: number;
  kind: NoteKind;
  number: number | null;
  day_n: number | null;
  lat: number | null;
  lon: number | null;
  title: string;
  text: string;
  created: string;
  updated: string;
  rev: number;
  at: string | null;
  extra: string;
  /** The client's id for a placement, so a retried request finds the note it already made. */
  client_id: string | null;
}

export interface MediaRow {
  id: number;
  trip_id: number;
  note_id: number;
  position: number;
  immich_id: string | null;
  type: MediaType;
  caption: string | null;
  taken_at: string | null;
  lat: number | null;
  lon: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  v: string;
  created: string;
  /** When Immich last reported the asset gone or trashed; hidden while set. */
  unavailable_at: string | null;
}

export interface MapRow {
  id: number;
  slug: string;
  title: string;
  created: string;
  rev: number;
  /** JSON `MapSettings`. */
  settings: string;
  /** 32 hex characters; names the link preview's picture and nothing else. */
  preview_id: string;
}

export interface MapShareRow {
  id: number;
  map_id: number;
  role: "view" | "edit";
  label: string;
  token_hash: string;
  token: string;
  created: string;
  revoked_at: string | null;
}

export interface EntryRow {
  id: number;
  map_id: number;
  name: string;
  emoji: string | null;
  color: number;
  note: string;
  /** JSON `Place[]`. */
  places: string;
  created: string;
  updated: string;
  updated_by: string | null;
  rev: number;
  deleted_at: string | null;
  client_id: string | null;
  /** An `avatar` row's id. */
  avatar: string | null;
}

export interface AvatarRow {
  map_id: number;
  id: string;
  type: string;
  bytes: Uint8Array;
  created: string;
}

export interface MeetMemberRow {
  map_id: number;
  entry_id: number;
  weight: number;
  mode: MeetMode;
  place_id: string | null;
  updated: string;
}

export interface EntryRevRow {
  id: number;
  entry_id: number;
  at: string;
  by: string | null;
  action: EntryAction;
  /** JSON `Entry`. */
  snapshot: string;
}

/** The fields of an entry a write sets. */
export type EntryContent = Pick<
  EntryRow,
  "name" | "emoji" | "color" | "note" | "places" | "updated" | "updated_by" | "deleted_at" | "avatar"
>;

interface DayRow {
  n: number;
  date: string;
  track: string;
  stats: string | null;
  end_point: string | null;
  source: string | null;
}

const json = (s: string | null) => (s == null ? null : JSON.parse(s));

/** Row access for one database. Every write that changes what a trip shows bumps the trip's `rev`. */
export class Store {
  constructor(readonly db: Database) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  bump(tripId: number): void {
    this.db.query("UPDATE trip SET rev = rev + 1 WHERE id = ?").run(tripId);
  }

  // ---- trips
  trips(): TripRow[] {
    return this.db.query("SELECT * FROM trip ORDER BY start_date, id").all() as TripRow[];
  }
  tripBySlug(slug: string): TripRow | null {
    return this.db.query("SELECT * FROM trip WHERE slug = ?").get(slug) as TripRow | null;
  }
  tripById(id: number): TripRow | null {
    return this.db.query("SELECT * FROM trip WHERE id = ?").get(id) as TripRow | null;
  }
  insertTrip(t: Omit<TripRow, "id" | "rev">): TripRow {
    return this.db
      .query(
        `INSERT INTO trip (slug, title, short_title, timezone, start_date, created, extra, privacy)
         VALUES ($slug, $title, $short_title, $timezone, $start_date, $created, $extra, $privacy) RETURNING *`,
      )
      .get(t) as TripRow;
  }
  updateTrip(
    id: number,
    t: Pick<TripRow, "title" | "short_title" | "timezone" | "start_date" | "extra" | "privacy">,
  ): void {
    this.db
      .query(
        `UPDATE trip SET title = $title, short_title = $short_title, timezone = $timezone, start_date = $start_date,
         extra = $extra, privacy = $privacy, rev = rev + 1 WHERE id = $id`,
      )
      .run({ ...t, id });
  }

  // ---- shares
  shareByHash(hash: string): ShareRow | null {
    return this.db.query("SELECT * FROM share WHERE token_hash = ?").get(hash) as ShareRow | null;
  }
  shares(tripId: number): ShareRow[] {
    return this.db.query("SELECT * FROM share WHERE trip_id = ? ORDER BY id").all(tripId) as ShareRow[];
  }
  insertShare(s: Omit<ShareRow, "id" | "revoked_at">): ShareRow {
    return this.db
      .query(
        `INSERT INTO share (trip_id, role, label, token_hash, token, created, editor, base_id)
         VALUES ($trip_id, $role, $label, $token_hash, $token, $created, $editor, $base_id) RETURNING *`,
      )
      .get(s) as ShareRow;
  }
  shareById(tripId: number, id: number): ShareRow | null {
    return this.db.query("SELECT * FROM share WHERE trip_id = ? AND id = ?").get(tripId, id) as ShareRow | null;
  }
  revokeShare(tripId: number, id: number, at: string): boolean {
    return (
      this.db
        .query("UPDATE share SET revoked_at = ? WHERE trip_id = ? AND id = ? AND revoked_at IS NULL")
        .run(at, tripId, id).changes > 0
    );
  }

  // ---- days and waypoints
  days(tripId: number): Day[] {
    const rows = this.db.query("SELECT * FROM day WHERE trip_id = ? ORDER BY n").all(tripId) as DayRow[];
    return rows.map((r) => ({
      n: r.n,
      date: r.date,
      track: JSON.parse(r.track),
      stats: json(r.stats),
      end: json(r.end_point),
      source: json(r.source),
    }));
  }
  putDay(tripId: number, d: Day): void {
    this.db
      .query(
        `INSERT INTO day (trip_id, n, date, track, stats, end_point, source) VALUES ($trip_id, $n, $date, $track, $stats, $end, $source)
         ON CONFLICT (trip_id, n) DO UPDATE SET date = excluded.date, track = excluded.track, stats = excluded.stats,
         end_point = excluded.end_point, source = excluded.source`,
      )
      .run({
        trip_id: tripId,
        n: d.n,
        date: d.date,
        track: JSON.stringify(d.track),
        stats: d.stats == null ? null : JSON.stringify(d.stats),
        end: d.end == null ? null : JSON.stringify(d.end),
        source: d.source == null ? null : JSON.stringify(d.source),
      });
  }
  deleteDay(tripId: number, n: number): boolean {
    return this.db.query("DELETE FROM day WHERE trip_id = ? AND n = ?").run(tripId, n).changes > 0;
  }
  waypoints(tripId: number): Waypoint[] {
    return this.db
      .query(
        "SELECT id, name, kind, lat, lon, day, passed_time, notes FROM waypoint WHERE trip_id = ? ORDER BY day, passed_time, id",
      )
      .all(tripId) as Waypoint[];
  }
  replaceWaypoints(tripId: number, list: Waypoint[]): void {
    this.db.query("DELETE FROM waypoint WHERE trip_id = ?").run(tripId);
    const ins = this.db.query(
      `INSERT INTO waypoint (trip_id, id, name, kind, lat, lon, day, passed_time, notes)
       VALUES ($trip_id, $id, $name, $kind, $lat, $lon, $day, $passed_time, $notes)`,
    );
    for (const w of list) ins.run({ trip_id: tripId, ...w });
  }

  // ---- notes
  notes(tripId: number): NoteRow[] {
    return this.db.query("SELECT * FROM note WHERE trip_id = ?").all(tripId) as NoteRow[];
  }
  noteByNumber(tripId: number, number: number): NoteRow | null {
    return this.db
      .query("SELECT * FROM note WHERE trip_id = ? AND kind = 'note' AND number = ?")
      .get(tripId, number) as NoteRow | null;
  }
  noteByDay(tripId: number, day: number): NoteRow | null {
    return this.db
      .query("SELECT * FROM note WHERE trip_id = ? AND kind = 'day' AND day_n = ?")
      .get(tripId, day) as NoteRow | null;
  }
  noteCount(tripId: number): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM note WHERE trip_id = ? AND kind = 'note'").get(tripId) as { n: number }
    ).n;
  }
  maxNumber(tripId: number): number {
    const r = this.db.query("SELECT MAX(number) AS m FROM note WHERE trip_id = ?").get(tripId) as { m: number | null };
    return r.m ?? 0;
  }
  noteByClientId(tripId: number, clientId: string): NoteRow | null {
    return this.db
      .query("SELECT * FROM note WHERE trip_id = ? AND client_id = ?")
      .get(tripId, clientId) as NoteRow | null;
  }
  insertNote(n: Omit<NoteRow, "id" | "rev" | "client_id"> & { client_id?: string | null }): NoteRow {
    return this.db
      .query(
        `INSERT INTO note (trip_id, kind, number, day_n, lat, lon, title, text, created, updated, at, extra, client_id)
         VALUES ($trip_id, $kind, $number, $day_n, $lat, $lon, $title, $text, $created, $updated, $at, $extra, $client_id) RETURNING *`,
      )
      .get({ client_id: null, ...n }) as NoteRow;
  }
  updateNote(n: NoteRow): NoteRow {
    return this.db
      .query(
        `UPDATE note SET lat = $lat, lon = $lon, title = $title, text = $text, at = $at, extra = $extra,
         updated = $updated, rev = rev + 1 WHERE id = $id RETURNING *`,
      )
      .get({
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        title: n.title,
        text: n.text,
        at: n.at,
        extra: n.extra,
        updated: n.updated,
      }) as NoteRow;
  }
  touchNote(id: number, updated: string): void {
    this.db.query("UPDATE note SET rev = rev + 1, updated = ? WHERE id = ?").run(updated, id);
  }
  deleteNote(id: number): void {
    this.db.query("DELETE FROM note WHERE id = ?").run(id);
  }

  // ---- media
  mediaOfTrip(tripId: number): MediaRow[] {
    return this.db
      .query("SELECT * FROM media WHERE trip_id = ? ORDER BY note_id, position, id")
      .all(tripId) as MediaRow[];
  }
  mediaOfNote(noteId: number): MediaRow[] {
    return this.db.query("SELECT * FROM media WHERE note_id = ? ORDER BY position, id").all(noteId) as MediaRow[];
  }
  mediaById(tripId: number, id: number): MediaRow | null {
    return this.db.query("SELECT * FROM media WHERE trip_id = ? AND id = ?").get(tripId, id) as MediaRow | null;
  }
  /** The table's `source` column is always 'immich'; its `file` and `bytes` columns stay unset. */
  insertMedia(m: Omit<MediaRow, "id" | "unavailable_at">): MediaRow {
    return this.db
      .query(
        `INSERT INTO media (trip_id, note_id, position, source, immich_id, type, caption, taken_at, lat, lon, width, height, duration_ms, v, created)
         VALUES ($trip_id, $note_id, $position, 'immich', $immich_id, $type, $caption, $taken_at, $lat, $lon, $width, $height, $duration_ms, $v, $created)
         RETURNING *`,
      )
      .get(m) as MediaRow;
  }
  setCaption(id: number, caption: string | null): void {
    this.db.query("UPDATE media SET caption = ? WHERE id = ?").run(caption, id);
  }
  /** Rewrites positions 0…n-1 in the given order. */
  setOrder(ids: number[]): void {
    const q = this.db.query("UPDATE media SET position = ? WHERE id = ?");
    for (const [i, id] of ids.entries()) q.run(i, id);
  }
  /** Media ids with their Immich assets, for the availability sweep. */
  immichMedia(): Pick<MediaRow, "id" | "trip_id" | "immich_id" | "unavailable_at">[] {
    return this.db.query("SELECT id, trip_id, immich_id, unavailable_at FROM media").all() as Pick<
      MediaRow,
      "id" | "trip_id" | "immich_id" | "unavailable_at"
    >[];
  }
  setUnavailable(id: number, at: string | null): void {
    this.db.query("UPDATE media SET unavailable_at = ? WHERE id = ?").run(at, id);
  }
  deleteMedia(id: number): void {
    this.db.query("DELETE FROM media WHERE id = ?").run(id);
  }

  // ---- maps
  maps(): MapRow[] {
    return this.db.query("SELECT * FROM map ORDER BY id").all() as MapRow[];
  }
  mapBySlug(slug: string): MapRow | null {
    return this.db.query("SELECT * FROM map WHERE slug = ?").get(slug) as MapRow | null;
  }
  mapById(id: number): MapRow | null {
    return this.db.query("SELECT * FROM map WHERE id = ?").get(id) as MapRow | null;
  }
  mapByPreviewId(id: string): MapRow | null {
    return this.db.query("SELECT * FROM map WHERE preview_id = ?").get(id) as MapRow | null;
  }
  insertMap(m: Pick<MapRow, "slug" | "title" | "created" | "settings">): MapRow {
    return this.db
      .query(
        `INSERT INTO map (slug, title, created, settings, preview_id)
         VALUES ($slug, $title, $created, $settings, $preview_id) RETURNING *`,
      )
      .get({ ...m, preview_id: randomBytes(16).toString("hex") }) as MapRow;
  }
  /** A new preview id; the picture's old URL stops answering. */
  rotatePreviewId(id: number): void {
    this.db.query("UPDATE map SET preview_id = ? WHERE id = ?").run(randomBytes(16).toString("hex"), id);
  }
  updateMap(id: number, m: Pick<MapRow, "title" | "settings">): MapRow {
    return this.db
      .query("UPDATE map SET title = $title, settings = $settings, rev = rev + 1 WHERE id = $id RETURNING *")
      .get({ ...m, id }) as MapRow;
  }
  deleteMap(id: number): void {
    this.db.query("DELETE FROM map WHERE id = ?").run(id);
  }
  bumpMap(id: number): void {
    this.db.query("UPDATE map SET rev = rev + 1 WHERE id = ?").run(id);
  }

  // ---- map shares
  mapShareByHash(hash: string): MapShareRow | null {
    return this.db.query("SELECT * FROM map_share WHERE token_hash = ?").get(hash) as MapShareRow | null;
  }
  mapShares(mapId: number): MapShareRow[] {
    return this.db.query("SELECT * FROM map_share WHERE map_id = ? ORDER BY id").all(mapId) as MapShareRow[];
  }
  insertMapShare(s: Omit<MapShareRow, "id" | "revoked_at">): MapShareRow {
    return this.db
      .query(
        `INSERT INTO map_share (map_id, role, label, token_hash, token, created)
         VALUES ($map_id, $role, $label, $token_hash, $token, $created) RETURNING *`,
      )
      .get(s) as MapShareRow;
  }
  revokeMapShare(mapId: number, id: number, at: string): boolean {
    return (
      this.db
        .query("UPDATE map_share SET revoked_at = ? WHERE map_id = ? AND id = ? AND revoked_at IS NULL")
        .run(at, mapId, id).changes > 0
    );
  }

  // ---- entries
  entries(mapId: number): EntryRow[] {
    return this.db.query("SELECT * FROM entry WHERE map_id = ? ORDER BY id").all(mapId) as EntryRow[];
  }
  entryCount(mapId: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM entry WHERE map_id = ?").get(mapId) as { n: number }).n;
  }
  liveEntryCount(mapId: number): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM entry WHERE map_id = ? AND deleted_at IS NULL").get(mapId) as {
        n: number;
      }
    ).n;
  }
  /** The colour of the map's newest entry. */
  lastEntryColor(mapId: number): number | null {
    const r = this.db.query("SELECT color FROM entry WHERE map_id = ? ORDER BY id DESC LIMIT 1").get(mapId) as {
      color: number;
    } | null;
    return r?.color ?? null;
  }
  entryById(mapId: number, id: number): EntryRow | null {
    return this.db.query("SELECT * FROM entry WHERE map_id = ? AND id = ?").get(mapId, id) as EntryRow | null;
  }
  entryByClientId(mapId: number, clientId: string): EntryRow | null {
    return this.db
      .query("SELECT * FROM entry WHERE map_id = ? AND client_id = ?")
      .get(mapId, clientId) as EntryRow | null;
  }
  insertEntry(e: Omit<EntryRow, "id" | "rev" | "deleted_at" | "avatar">): EntryRow {
    return this.db
      .query(
        `INSERT INTO entry (map_id, name, emoji, color, note, places, created, updated, updated_by, client_id)
         VALUES ($map_id, $name, $emoji, $color, $note, $places, $created, $updated, $updated_by, $client_id) RETURNING *`,
      )
      .get(e) as EntryRow;
  }
  updateEntry(id: number, e: EntryContent): EntryRow {
    return this.db
      .query(
        `UPDATE entry SET name = $name, emoji = $emoji, color = $color, note = $note, places = $places,
         updated = $updated, updated_by = $updated_by, deleted_at = $deleted_at, avatar = $avatar, rev = rev + 1
         WHERE id = $id RETURNING *`,
      )
      .get({ ...e, id }) as EntryRow;
  }
  /** Appends a history row and keeps the newest `keep` of the entry. */
  insertEntryRev(r: Omit<EntryRevRow, "id">, keep: number): EntryRevRow {
    const row = this.db
      .query(
        "INSERT INTO entry_rev (entry_id, at, by, action, snapshot) VALUES ($entry_id, $at, $by, $action, $snapshot) RETURNING *",
      )
      .get(r) as EntryRevRow;
    this.db
      .query(
        `DELETE FROM entry_rev WHERE entry_id = ? AND id NOT IN
         (SELECT id FROM entry_rev WHERE entry_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(r.entry_id, r.entry_id, keep);
    return row;
  }
  entryRevs(entryId: number): EntryRevRow[] {
    return this.db.query("SELECT * FROM entry_rev WHERE entry_id = ? ORDER BY id DESC").all(entryId) as EntryRevRow[];
  }
  entryRev(entryId: number, id: number): EntryRevRow | null {
    return this.db
      .query("SELECT * FROM entry_rev WHERE entry_id = ? AND id = ?")
      .get(entryId, id) as EntryRevRow | null;
  }
  // ---- avatars
  avatar(mapId: number, id: string): AvatarRow | null {
    return this.db.query("SELECT * FROM avatar WHERE map_id = ? AND id = ?").get(mapId, id) as AvatarRow | null;
  }
  putAvatar(a: AvatarRow): void {
    this.db
      .query(
        `INSERT INTO avatar (map_id, id, type, bytes, created) VALUES ($map_id, $id, $type, $bytes, $created)
         ON CONFLICT (map_id, id) DO NOTHING`,
      )
      .run({ ...a });
  }
  /** Removes pictures no entry and no history state names; returns how many. */
  purgeAvatars(): number {
    return this.db
      .query(
        `DELETE FROM avatar WHERE NOT EXISTS (SELECT 1 FROM entry e WHERE e.map_id = avatar.map_id AND e.avatar = avatar.id)
         AND NOT EXISTS (SELECT 1 FROM entry_rev r JOIN entry e ON e.id = r.entry_id
           WHERE e.map_id = avatar.map_id AND json_extract(r.snapshot, '$.avatar') = avatar.id)`,
      )
      .run().changes;
  }

  // ---- the meeting point
  meetMembers(mapId: number): MeetMemberRow[] {
    return this.db.query("SELECT * FROM meet_member WHERE map_id = ? ORDER BY entry_id").all(mapId) as MeetMemberRow[];
  }
  putMeetMember(m: MeetMemberRow): void {
    this.db
      .query(
        `INSERT INTO meet_member (map_id, entry_id, weight, mode, place_id, updated)
         VALUES ($map_id, $entry_id, $weight, $mode, $place_id, $updated)
         ON CONFLICT (map_id, entry_id) DO UPDATE SET weight = excluded.weight, mode = excluded.mode,
         place_id = excluded.place_id, updated = excluded.updated`,
      )
      .run({ ...m });
  }
  deleteMeetMember(mapId: number, entryId: number): void {
    this.db.query("DELETE FROM meet_member WHERE map_id = ? AND entry_id = ?").run(mapId, entryId);
  }
  meetResult(mapId: number): { inputs_hash: string; result: string } | null {
    return this.db.query("SELECT inputs_hash, result FROM meet_result WHERE map_id = ?").get(mapId) as {
      inputs_hash: string;
      result: string;
    } | null;
  }
  putMeetResult(mapId: number, hash: string, result: string): void {
    this.db
      .query(
        `INSERT INTO meet_result (map_id, inputs_hash, result) VALUES (?, ?, ?)
         ON CONFLICT (map_id) DO UPDATE SET inputs_hash = excluded.inputs_hash, result = excluded.result`,
      )
      .run(mapId, hash, result);
  }
  /** A cached time fetched at or after `since`, a "no connection" at or after `sinceNone`; null without one. */
  travelTime(
    mode: MeetMode,
    from: string,
    to: string,
    since: string,
    sinceNone: string,
  ): { minutes: number | null } | null {
    return this.db
      .query(
        `SELECT minutes FROM travel_time WHERE mode = ? AND from_key = ? AND to_key = ?
         AND fetched >= CASE WHEN minutes IS NULL THEN ? ELSE ? END`,
      )
      .get(mode, from, to, sinceNone, since) as { minutes: number | null } | null;
  }
  putTravelTime(mode: MeetMode, from: string, to: string, minutes: number | null, at: string | null, fetched: string) {
    this.db
      .query(
        `INSERT INTO travel_time (mode, from_key, to_key, minutes, at, fetched) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (mode, from_key, to_key) DO UPDATE SET minutes = excluded.minutes, at = excluded.at, fetched = excluded.fetched`,
      )
      .run(mode, from, to, minutes, at, fetched);
  }

  /** Removes one deleted entry for good; false when there is no such deleted entry. */
  purgeEntry(mapId: number, id: number): boolean {
    return this.tx(() => {
      const gone = this.db
        .query("DELETE FROM entry WHERE map_id = ? AND id = ? AND deleted_at IS NOT NULL RETURNING id")
        .all(mapId, id);
      if (gone.length) this.bumpMap(mapId);
      return gone.length > 0;
    });
  }

  /** Removes entries deleted before `cutoff` for good; returns how many. */
  purgeTrash(cutoff: string): number {
    return this.tx(() => {
      const gone = this.db
        .query("DELETE FROM entry WHERE deleted_at IS NOT NULL AND deleted_at < ? RETURNING map_id")
        .all(cutoff) as { map_id: number }[];
      for (const id of new Set(gone.map((g) => g.map_id))) this.bumpMap(id);
      return gone.length;
    });
  }
}
