// Where a note sits in the trip's timeline. The rules are documented on `AnchorRule` in
// src/shared/api.ts; this file is their only implementation.
import type { AnchorRule, Day } from "../shared/api";
import { localDate, zonedInstant } from "../shared/time";

/** Segments within this distance of the best one belong to a candidate pass. */
export const PASS_TOLERANCE_M = 30;
/** Farther than this from every track counts as off the track. */
export const OFF_TRACK_M = 300;
/** A rest day's end, local time. */
const REST_DAY_END: [number, number] = [18, 0];

interface Pt {
  lat: number;
  lon: number;
  t: number;
  /** Kilometres from the day's start, scaled to the recorded distance; recording gaps add none. */
  km: number;
  /** The stretch from the point before to this one is a gap between recordings: no anchor snaps to it. */
  gap: boolean;
}

export interface PreparedDay {
  n: number;
  date: string;
  pts: Pt[];
  /** Where the day ended: the camp, else the last track point. */
  end: { lat: number; lon: number } | null;
}

export interface PreparedTrip {
  tz: string;
  days: PreparedDay[];
  /** Time of the last track point of the whole trip; -Infinity without tracks. */
  lastT: number;
}

export interface AnchorResult {
  t: number;
  rule: AnchorRule;
  day: number | null;
  dist_m: number | null;
  km: number | null;
  off_track: boolean;
}

const RAD = Math.PI / 180;

export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

export function prepareTrip(days: Day[], tz: string): PreparedTrip {
  const prepared = [...days]
    .sort((a, b) => a.n - b.n)
    .map((d): PreparedDay => {
      let km = 0;
      const breaks = new Set(d.breaks);
      const pts = d.track.map((p, i): Pt => {
        const prev = d.track[i - 1];
        const gap = breaks.has(i);
        if (prev && !gap) km += haversineM(prev[0], prev[1], p[0], p[1]) / 1000;
        return { lat: p[0], lon: p[1], t: Date.parse(p[3]), km, gap };
      });
      const recorded = d.stats?.km;
      if (recorded && km > 0) for (const p of pts) p.km *= recorded / km;
      const last = pts.at(-1);
      const end = d.end ? { lat: d.end.lat, lon: d.end.lon } : last ? { lat: last.lat, lon: last.lon } : null;
      return { n: d.n, date: d.date, pts, end };
    });
  let lastT = Number.NEGATIVE_INFINITY;
  for (const d of prepared) for (const p of d.pts) lastT = Math.max(lastT, p.t);
  return { tz, days: prepared, lastT };
}

interface Hit {
  day: number;
  /** Index of the segment's first point. */
  i: number;
  dist: number;
  t: number;
  km: number;
}

/** The nearest point of each segment of every track within `PASS_TOLERANCE_M` of the best one. */
function project(lat: number, lon: number, trip: PreparedTrip): Hit[] {
  const kx = Math.cos(lat * RAD) * 111320;
  const ky = 110540;
  // First pass: distances only, so the common case allocates nothing per segment.
  const dist: number[] = [];
  const frac: number[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const d of trip.days) {
    const { pts } = d;
    const n = pts.length === 1 ? 1 : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i] as Pt;
      const b = (pts[i + 1] ?? a) as Pt;
      if (b.gap) {
        dist.push(Number.POSITIVE_INFINITY);
        frac.push(0);
        continue;
      }
      const ax = (a.lon - lon) * kx;
      const ay = (a.lat - lat) * ky;
      const dx = (b.lon - a.lon) * kx;
      const dy = (b.lat - a.lat) * ky;
      const len = dx * dx + dy * dy;
      const f = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const ex = ax + f * dx;
      const ey = ay + f * dy;
      const dd = Math.sqrt(ex * ex + ey * ey);
      dist.push(dd);
      frac.push(f);
      if (dd < best) best = dd;
    }
  }
  const hits: Hit[] = [];
  let k = 0;
  for (const d of trip.days) {
    const { pts } = d;
    const n = pts.length === 1 ? 1 : pts.length - 1;
    for (let i = 0; i < n; i++, k++) {
      const dd = dist[k] as number;
      if (dd === Number.POSITIVE_INFINITY || dd > best + PASS_TOLERANCE_M) continue;
      const a = pts[i] as Pt;
      const b = (pts[i + 1] ?? a) as Pt;
      const f = frac[k] as number;
      hits.push({ day: d.n, i, dist: dd, t: a.t + f * (b.t - a.t), km: a.km + f * (b.km - a.km) });
    }
  }
  return hits;
}

/** Runs of consecutive segments of one day among the hits; each is represented by its nearest hit. */
function passes(hits: Hit[]): Hit[] {
  const out: { day: number; end: number; best: Hit }[] = [];
  for (const h of hits) {
    const last = out.at(-1);
    if (last && last.day === h.day && last.end === h.i - 1) {
      last.end = h.i;
      if (h.dist < last.best.dist) last.best = h;
    } else out.push({ day: h.day, end: h.i, best: h });
  }
  return out.map((p) => p.best).sort((a, b) => a.t - b.t);
}

/** The day an instant belongs to: the track spanning it, else the day of its local date, else the nearest track. */
export function dayAt(t: number, trip: PreparedTrip): number | null {
  for (const d of trip.days) {
    const first = d.pts[0];
    const last = d.pts.at(-1);
    if (first && last && t >= first.t && t <= last.t) return d.n;
  }
  const date = localDate(t, trip.tz);
  const byDate = trip.days.find((d) => d.date === date);
  if (byDate) return byDate.n;
  let best: { n: number; gap: number } | null = null;
  for (const d of trip.days) {
    const first = d.pts[0];
    const last = d.pts.at(-1);
    if (!first || !last) continue;
    const gap = t < first.t ? first.t - t : t - last.t;
    if (!best || gap < best.gap) best = { n: d.n, gap };
  }
  return best?.n ?? trip.days[0]?.n ?? null;
}

export interface NoteInput {
  /** Null for a note without a place, which always has `at`. */
  lat: number | null;
  lon: number | null;
  /** Manual time, ms. */
  at: number | null;
  /** Earliest capture time of the note's media, ms. */
  hint: number | null;
  /** Creation time, ms. */
  created: number;
}

export function anchorNote(note: NoteInput, trip: PreparedTrip): AnchorResult {
  const hits = note.lat == null || note.lon == null ? [] : project(note.lat, note.lon, trip);
  if (!hits.length) {
    const t = note.at ?? note.created;
    return {
      t,
      rule: note.at != null ? "at" : "created",
      day: dayAt(t, trip),
      dist_m: null,
      km: null,
      off_track: false,
    };
  }
  const candidates = passes(hits);
  const dist = Math.min(...candidates.map((c) => c.dist));
  const off = dist > OFF_TRACK_M;
  const round = Math.round(dist);
  if (note.at != null)
    return { t: note.at, rule: "at", day: dayAt(note.at, trip), dist_m: round, km: null, off_track: off };
  if (off && note.created > trip.lastT)
    return {
      t: note.created,
      rule: "created",
      day: dayAt(note.created, trip),
      dist_m: round,
      km: null,
      off_track: off,
    };
  const hint = note.hint;
  const pick =
    hint == null
      ? (candidates[0] as Hit)
      : candidates.reduce((a, b) => (Math.abs(b.t - hint) < Math.abs(a.t - hint) ? b : a));
  return {
    t: pick.t,
    rule: "track",
    day: pick.day,
    dist_m: Math.round(pick.dist),
    km: Math.round(pick.km * 100) / 100,
    off_track: off,
  };
}

export function anchorDayEnd(n: number, trip: PreparedTrip): AnchorResult {
  const d = trip.days.find((x) => x.n === n);
  if (!d) throw new Error(`day ${n} does not exist`);
  const last = d.pts.at(-1);
  if (last)
    return { t: last.t, rule: "day-end", day: n, dist_m: 0, km: Math.round(last.km * 100) / 100, off_track: false };
  return {
    t: zonedInstant(d.date, REST_DAY_END[0], REST_DAY_END[1], trip.tz),
    rule: "rest-day",
    day: n,
    dist_m: null,
    km: null,
    off_track: false,
  };
}

/** Where a day-end note stands: its day's end; a rest day stays at the previous day's end (else the next day's). */
export function dayEndPosition(n: number, trip: PreparedTrip): { lat: number; lon: number } | null {
  const i = trip.days.findIndex((x) => x.n === n);
  const own = trip.days[i]?.end;
  if (own) return own;
  for (let j = i - 1; j >= 0; j--) {
    const e = trip.days[j]?.end;
    if (e) return e;
  }
  for (let j = i + 1; j < trip.days.length; j++) {
    const first = trip.days[j]?.pts[0];
    if (first) return { lat: first.lat, lon: first.lon };
  }
  return null;
}

/** The track position at instant `t`, interpolated; null outside every recorded track. */
export function positionAt(t: number, trip: PreparedTrip): { day: number; lat: number; lon: number } | null {
  for (const d of trip.days) {
    for (let i = 0; i + 1 < d.pts.length; i++) {
      const a = d.pts[i] as Pt;
      const b = d.pts[i + 1] as Pt;
      if (t < a.t || t > b.t) continue;
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { day: d.n, lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) };
    }
  }
  return null;
}

export interface Orderable {
  t: number;
  kind: "note" | "day";
  number: number | null;
  day: number | null;
}

/** Timeline order: time, then numbered notes before day-end notes, then number (day-end notes by day). */
export function compareTimeline(a: Orderable, b: Orderable): number {
  return (
    a.t - b.t ||
    (a.kind === "day" ? 1 : 0) - (b.kind === "day" ? 1 : 0) ||
    (a.number ?? a.day ?? 0) - (b.number ?? b.day ?? 0)
  );
}
