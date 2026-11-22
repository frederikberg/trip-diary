// Rows → API shapes: notes with their anchors in timeline order, media with their URLs.
import type { Day, Media, MediaSize, Note, NoteKey, Share, Trip, TripPrivacy, TripView } from "../shared/api";
import { isoInZone } from "../shared/time";
import type { MediaRow, NoteRow, ShareRow, Store, TripRow } from "./db";
import { anchorDayEnd, anchorNote, compareTimeline, dayEndPosition, type PreparedTrip, prepareTrip } from "./ordering";

export const noteKey = (n: Pick<NoteRow, "kind" | "number" | "day_n">): NoteKey =>
  n.kind === "day" ? `d${n.day_n}` : String(n.number);

export function parseNoteKey(key: string): { kind: "note"; number: number } | { kind: "day"; day: number } | null {
  if (/^[1-9]\d{0,6}$/.test(key)) return { kind: "note", number: Number(key) };
  const m = /^d([1-9]\d{0,3})$/.exec(key);
  return m ? { kind: "day", day: Number(m[1]) } : null;
}

export function privacyOf(t: TripRow): TripPrivacy {
  const p = JSON.parse(t.privacy) as Partial<TripPrivacy>;
  return { hide_camps: p.hide_camps === true, delay_hours: typeof p.delay_hours === "number" ? p.delay_hours : 0 };
}

/** View links get neither `extra` nor anything else only editors need. */
export const tripOut = (t: TripRow, editable = true): Trip => ({
  slug: t.slug,
  title: t.title,
  short_title: t.short_title,
  timezone: t.timezone,
  start_date: t.start_date,
  extra: editable ? JSON.parse(t.extra) : {},
  privacy: privacyOf(t),
});

export function shareOut(s: ShareRow, publicUrl: string): Share {
  return {
    id: s.id,
    role: s.role,
    label: s.label,
    created: s.created,
    revoked_at: s.revoked_at,
    url: s.role === "view" && s.token && !s.editor ? `${publicUrl}/${s.token}` : null,
    editor: s.editor === 1,
    base: s.base_id,
  };
}

export interface ViewScope {
  /** Prefix of the media routes, e.g. `/api/t/<token>`. */
  base: string;
  editable: boolean;
  /** Include Immich asset ids. */
  ids: boolean;
  /** `TripView.share_url`. */
  shareUrl: string | null;
  /** `TripView.sign_out_path`. */
  signOutPath: string | null;
}

export function mediaOut(m: MediaRow, scope: ViewScope): Media {
  const url = (size: MediaSize) => `${scope.base}/m/${m.id}/${size}?v=${m.v}`;
  const out: Media = {
    id: m.id,
    type: m.type,
    caption: m.caption,
    position: m.position,
    taken_at: m.taken_at,
    lat: m.lat,
    lon: m.lon,
    width: m.width,
    height: m.height,
    duration_ms: m.duration_ms,
    v: m.v,
    thumb: url("thumb"),
    preview: url("preview"),
    video: m.type === "video" ? url("video") : null,
  };
  if (scope.ids) {
    out.immich_id = m.immich_id;
    out.unavailable_at = m.unavailable_at;
  }
  return out;
}

/** The earliest capture time among a note's media, as the hint for picking a pass. */
function hint(media: MediaRow[]): number | null {
  let best: number | null = null;
  for (const m of media) {
    const t = m.taken_at ? Date.parse(m.taken_at) : Number.NaN;
    if (Number.isFinite(t) && (best == null || t < best)) best = t;
  }
  return best;
}

export function noteOut(row: NoteRow, media: MediaRow[], trip: PreparedTrip, scope: ViewScope): Note {
  const tz = trip.tz;
  let a: ReturnType<typeof anchorNote>;
  let lat = row.lat;
  let lon = row.lon;
  if (row.kind === "day") {
    a = anchorDayEnd(row.day_n as number, trip);
    const pos = dayEndPosition(row.day_n as number, trip);
    lat = pos?.lat ?? 0;
    lon = pos?.lon ?? 0;
  } else {
    a = anchorNote(
      {
        lat: row.lat,
        lon: row.lon,
        at: row.at ? Date.parse(row.at) : null,
        hint: hint(media),
        created: Date.parse(row.created),
      },
      trip,
    );
  }
  return {
    key: noteKey(row),
    kind: row.kind,
    number: row.number,
    day: row.day_n,
    lat,
    lon,
    title: row.title,
    text: row.text,
    created: row.created,
    updated: row.updated,
    rev: row.rev,
    at: row.at,
    extra: scope.editable ? JSON.parse(row.extra) : {},
    media: media.map((m) => mediaOut(m, scope)),
    anchor: {
      t: isoInZone(a.t, tz),
      rule: a.rule,
      day: a.day,
      dist_m: a.dist_m,
      km: a.km,
      off_track: a.off_track,
    },
  };
}

interface Built {
  view: TripView;
  prepared: PreparedTrip;
}

/** Built views by trip, revision and scope; a write bumps the revision, so an entry never goes stale. */
const cache = new Map<string, Built>();

/** The whole trip as the clients see it. Callers must not mutate the result. */
export function buildView(store: Store, t: TripRow, scope: ViewScope, now = Date.now()): Built {
  // A delay hides notes by age, so such a view also changes with the clock (in 5-minute steps).
  const delayed = !scope.editable && privacyOf(t).delay_hours > 0;
  const clock = delayed ? Math.floor(now / 300_000) : 0;
  const key = `${t.id}:${t.rev}:${scope.base}:${scope.editable}:${scope.ids}:${scope.shareUrl}:${clock}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(store, t, scope, clock * 300_000);
  if (cache.size > 64) cache.clear();
  cache.set(key, built);
  return built;
}

function build(store: Store, t: TripRow, scope: ViewScope, now: number): Built {
  const all = store.days(t.id);
  const prepared = prepareTrip(all, t.timezone);
  const privacy = privacyOf(t);
  const days: Day[] = scope.editable
    ? all
    : all.map((d) => ({
        ...d,
        source: null,
        end: d.end && privacy.hide_camps ? { lat: d.end.lat, lon: d.end.lon, camp_type: null, name: null } : d.end,
      }));
  const cutoff = privacy.delay_hours > 0 ? now - privacy.delay_hours * 3_600_000 : Number.POSITIVE_INFINITY;
  const byNote = new Map<number, MediaRow[]>();
  for (const m of store.mediaOfTrip(t.id)) {
    if (m.unavailable_at && !scope.editable) continue;
    const list = byNote.get(m.note_id) ?? [];
    list.push(m);
    byNote.set(m.note_id, list);
  }
  for (const list of byNote.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
  const notes = store
    .notes(t.id)
    .filter((n) => n.kind === "note" || days.some((d) => d.n === n.day_n))
    .filter((n) => scope.editable || n.kind === "day" || Date.parse(n.created) <= cutoff)
    .map((n) => noteOut(n, byNote.get(n.id) ?? [], prepared, scope));
  const order = (n: Note) => ({ t: Date.parse(n.anchor.t), kind: n.kind, number: n.number, day: n.day });
  notes.sort((a, b) => compareTimeline(order(a), order(b)));
  return {
    view: {
      trip: tripOut(t, scope.editable),
      days,
      waypoints: store.waypoints(t.id),
      notes,
      editable: scope.editable,
      rev: t.rev,
      share_url: scope.editable ? scope.shareUrl : null,
      sign_out_path: scope.editable ? scope.signOutPath : null,
    },
    prepared,
  };
}
