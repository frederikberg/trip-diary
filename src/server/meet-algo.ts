// The arithmetic of the meeting point: no rows, no HTTP. The weighted middle and the ranking answer
// the same question, the least sum of weight × square, one on distance and one on minutes.
import { createHash } from "node:crypto";
import { zonedInstant } from "../shared/time";

export interface Weighted {
  lat: number;
  lon: number;
  weight: number;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** The mean of the points on the sphere, each counted `weight` times. */
export function weightedMiddle(points: Weighted[]): { lat: number; lon: number } | null {
  if (points.length < 2) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.weight * Math.cos(rad(p.lat)) * Math.cos(rad(p.lon));
    y += p.weight * Math.cos(rad(p.lat)) * Math.sin(rad(p.lon));
    z += p.weight * Math.sin(rad(p.lat));
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return { lat: round(deg(Math.atan2(z, Math.hypot(x, y)))), lon: round(deg(Math.atan2(y, x))) };
}

export function nearest<T extends { lat: number; lon: number }>(from: { lat: number; lon: number }, list: T[]): T {
  return list.reduce((a, b) => (kmBetween(from, b) < kmBetween(from, a) ? b : a));
}

/** The `n` nearest, nearest first. */
export function closest<T extends { lat: number; lon: number }>(
  from: { lat: number; lon: number },
  list: T[],
  n: number,
): T[] {
  return [...list].sort((a, b) => kmBetween(from, a) - kmBetween(from, b)).slice(0, n);
}

/** The stations inside the points' bounding box, widened by `km`. */
export function inBox<T extends { lat: number; lon: number }>(
  list: T[],
  points: { lat: number; lon: number }[],
  km: number,
): T[] {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos(rad(Math.max(...lats.map(Math.abs)))));
  const [s, n, w, e] = [
    Math.min(...lats) - dLat,
    Math.max(...lats) + dLat,
    Math.min(...lons) - dLon,
    Math.max(...lons) + dLon,
  ];
  return list.filter((c) => c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e);
}

/** A person nobody can get to counts as a day's travel, so such a place loses but stays comparable. */
const UNREACHABLE_MIN = 1440;

export function score(legs: { weight: number; minutes: number | null }[]): number {
  return legs.reduce((s, l) => s + l.weight * (l.minutes ?? UNREACHABLE_MIN) ** 2, 0);
}

export function meanMinutes(legs: { weight: number; minutes: number | null }[]): number {
  const known = legs.filter((l) => l.minutes != null);
  const people = known.reduce((s, l) => s + l.weight, 0);
  return people ? Math.round(known.reduce((s, l) => s + l.weight * (l.minutes as number), 0) / people) : 0;
}

export interface Input {
  entry_id: number;
  weight: number;
  mode: string;
  lat: number;
  lon: number;
}

/** What a result depends on, independent of the members' order. */
export function inputsHash(members: Input[]): string {
  const rows = [...members]
    .sort((a, b) => a.entry_id - b.entry_id)
    .map((m) => [m.entry_id, m.weight, m.mode, m.lat, m.lon]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** The next `weekday` (1 Monday … 7 Sunday) at `hour` in Europe/Berlin, as an instant. */
export function nextDeparture(now: Date, weekday: number, hour: number): number {
  const tz = "Europe/Berlin";
  for (let d = 1; d <= 8; d++) {
    const day = new Date(now.getTime() + d * 86_400_000);
    const date = day.toLocaleDateString("en-CA", { timeZone: tz });
    const at = zonedInstant(date, hour, 0, tz);
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    if (wd === weekday && at > now.getTime()) return at;
  }
  throw new Error("no such weekday");
}
