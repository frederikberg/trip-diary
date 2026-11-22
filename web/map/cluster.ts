// Greedy clustering in screen space. Points are taken in the order given, so the same points at the
// same zoom always group the same way.

export interface ScreenPoint {
  key: string;
  x: number;
  y: number;
}

/** Puts each point into the first group whose first point lies within `radius` pixels, else starts a group. */
export function cluster(points: ScreenPoint[], radius: number): string[][] {
  const groups: { seed: ScreenPoint; keys: string[] }[] = [];
  for (const p of points) {
    const g = groups.find((c) => Math.hypot(c.seed.x - p.x, c.seed.y - p.y) < radius);
    if (g) g.keys.push(p.key);
    else groups.push({ seed: p, keys: [p.key] });
  }
  return groups.map((g) => g.keys);
}

/**
 * Points no farther than `metres` from a spot's first point share that spot (a household at one
 * address). Returns, per key of a spot holding two to `max` points, its horizontal offset in pixels:
 * the points side by side, `gap` apart, centred on the spot, in the order given.
 */
export function fanOut(
  points: { key: string; lat: number; lon: number }[],
  metres: number,
  gap: number,
  max: number,
): Map<string, { spot: number; dx: number }> {
  const spots: { seed: { lat: number; lon: number }; keys: string[] }[] = [];
  for (const p of points) {
    const s = spots.find((c) => distanceM(c.seed, p) <= metres);
    if (s) s.keys.push(p.key);
    else spots.push({ seed: p, keys: [p.key] });
  }
  const out = new Map<string, { spot: number; dx: number }>();
  spots.forEach((s, spot) => {
    if (s.keys.length < 2 || s.keys.length > max) return;
    s.keys.forEach((k, i) => {
      out.set(k, { spot, dx: (i - (s.keys.length - 1) / 2) * gap });
    });
  });
  return out;
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = (b.lat - a.lat) * 111_320;
  const x = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(x, y);
}

/** The middle of the points. */
export function centroid(points: { lat: number; lon: number }[]): { lat: number; lon: number } {
  const n = points.length;
  return { lat: points.reduce((s, p) => s + p.lat, 0) / n, lon: points.reduce((s, p) => s + p.lon, 0) / n };
}
