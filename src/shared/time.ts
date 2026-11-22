// Time-zone arithmetic on top of Intl, for a trip's IANA zone.

const formats = new Map<string, Intl.DateTimeFormat>();

const parts = (ms: number, tz: string) => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return o as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
};

/** Offset of `tz` from UTC at instant `ms`, in minutes. */
export function offsetMinutes(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** `YYYY-MM-DD` of instant `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The instant of wall-clock time `hh:mm` on `date` (`YYYY-MM-DD`) in `tz`. */
export function zonedInstant(date: string, hh: number, mm: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ms = wall - offsetMinutes(wall, tz) * 60000;
  ms = wall - offsetMinutes(ms, tz) * 60000;
  return ms;
}

/** ISO-8601 with the offset `tz` has at `ms`, to the second. */
export function isoInZone(ms: number, tz: string): string {
  const off = offsetMinutes(ms, tz);
  const p = parts(ms, tz);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  const mm = String(a % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** Parses an ISO-8601 date-time with `Z` or an offset; NaN for anything else. */
export function parseIso(s: unknown): number {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s))
    return Number.NaN;
  return Date.parse(s);
}
