// GPX recordings to the app's day shape: the files of one day become one track, with `breaks` where a
// recording ends and the next begins. Pure functions, used by `trip days import-gpx`.
import type { DayPut, DayStats, TrackPoint } from "../src/shared/api";
import { isoInZone, localDate } from "../src/shared/time";

export interface GpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
  ms: number;
}

/** Spacing the stored track is thinned to, in metres: dense enough for the map, small enough to load fast. */
const MIN_SPACING_M = 15;
/** Elevation changes smaller than this do not count as ascent or descent (GPS noise). */
const ELE_NOISE_M = 3;
/** A pause this long within one recording, with a jump of at least `GAP_M`, is a gap between recordings (a train ride). */
const GAP_MS = 5 * 60_000;
const GAP_M = 1000;
/** Below this speed a stretch counts as standing still, in m/s. */
const MOVING_MS = 0.5;

const R = 6371000;
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The recordings of a file: one per `<trkseg>`, each in time order. Every point needs a `<time>`. */
export function parseGpx(xml: string, name = "gpx"): GpxPoint[][] {
  const segments = [...xml.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g)].map((m) => m[1] ?? "");
  const recordings = (segments.length ? segments : [xml]).map((seg) => parsePoints(seg, name)).filter((r) => r.length);
  if (recordings.reduce((n, r) => n + r.length, 0) < 2) throw new Error(`${name}: fewer than two track points`);
  return recordings;
}

function parsePoints(xml: string, name: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const m of xml.matchAll(/<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const lat = Number(/\blat\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const time = /<time>\s*([^<\s]+)\s*<\/time>/.exec(body)?.[1];
    const eleText = /<ele>\s*([^<\s]+)\s*<\/ele>/.exec(body)?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`${name}: a trkpt without lat/lon`);
    const ms = time ? Date.parse(time) : Number.NaN;
    if (!Number.isFinite(ms)) throw new Error(`${name}: a trkpt without a valid <time>; the app needs times`);
    const ele = eleText === undefined ? null : Number(eleText);
    points.push({ lat, lon, ele: ele !== null && Number.isFinite(ele) ? ele : null, ms });
  }
  return points.sort((a, b) => a.ms - b.ms);
}

/** Splits a recording where the watch kept running through a jump: a long pause and a long way. */
function splitAtJumps(points: GpxPoint[]): GpxPoint[][] {
  const out: GpxPoint[][] = [[]];
  for (const [i, p] of points.entries()) {
    const prev = points[i - 1];
    if (prev && p.ms - prev.ms >= GAP_MS && haversineM(prev, p) >= GAP_M) out.push([]);
    (out.at(-1) as GpxPoint[]).push(p);
  }
  return out;
}

/**
 * One day from its recordings: the thinned track, the recordings' own stats and the end of the last
 * one. Distance, moving time and ascent count only within a recording; `breaks` marks where each
 * recording after the first starts in the thinned track.
 */
export function dayFromGpx(recordings: GpxPoint[][], tz: string, source: string): DayPut {
  const rides = recordings
    .flatMap(splitAtJumps)
    .filter((r) => r.length)
    .sort((a, b) => (a[0] as GpxPoint).ms - (b[0] as GpxPoint).ms);
  const points = rides.flat();
  let km = 0;
  let movingMs = 0;
  let ascent = 0;
  let descent = 0;
  for (const ride of rides) {
    let ref: number | null = null;
    for (let i = 1; i < ride.length; i++) {
      const a = ride[i - 1] as GpxPoint;
      const b = ride[i] as GpxPoint;
      const d = haversineM(a, b);
      km += d / 1000;
      if (b.ms > a.ms && d / ((b.ms - a.ms) / 1000) >= MOVING_MS) movingMs += b.ms - a.ms;
    }
    for (const p of ride) {
      if (p.ele === null) continue;
      if (ref === null) ref = p.ele;
      else if (p.ele - ref >= ELE_NOISE_M) {
        ascent += p.ele - ref;
        ref = p.ele;
      } else if (ref - p.ele >= ELE_NOISE_M) {
        descent += ref - p.ele;
        ref = p.ele;
      }
    }
  }
  const eles = points.flatMap((p) => (p.ele === null ? [] : [p.ele]));
  const first = points[0] as GpxPoint;
  const last = points.at(-1) as GpxPoint;

  const kept: GpxPoint[] = [];
  const breaks: number[] = [];
  for (const ride of rides) {
    if (kept.length) breaks.push(kept.length);
    kept.push(ride[0] as GpxPoint);
    for (const p of ride.slice(1, -1)) if (haversineM(kept.at(-1) as GpxPoint, p) >= MIN_SPACING_M) kept.push(p);
    // A one-point recording has no last point of its own.
    if (ride.length > 1) kept.push(ride.at(-1) as GpxPoint);
  }
  const track: TrackPoint[] = kept.map((p) => [
    +p.lat.toFixed(6),
    +p.lon.toFixed(6),
    p.ele === null ? null : +p.ele.toFixed(1),
    isoInZone(p.ms, tz),
  ]);

  const stats: DayStats = {
    km: +km.toFixed(2),
    ascent_m: Math.round(ascent),
    descent_m: Math.round(descent),
    start_time: isoInZone(first.ms, tz),
    end_time: isoInZone(last.ms, tz),
    moving_time_min: Math.round(movingMs / 60000),
    elapsed_time_min: Math.round((last.ms - first.ms) / 60000),
    min_ele: eles.length ? Math.round(Math.min(...eles)) : 0,
    max_ele: eles.length ? Math.round(Math.max(...eles)) : 0,
  };
  return {
    date: localDate(first.ms, tz),
    track,
    ...(breaks.length ? { breaks } : {}),
    stats,
    end: { lat: last.lat, lon: last.lon, camp_type: null, name: null },
    source: { file: source },
  };
}
