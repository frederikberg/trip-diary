// Timeline anchors on the recorded tracks of a five-day sample hike (test/fixtures/hike.json).
import { describe, expect, test } from "bun:test";
import {
  anchorDayEnd,
  anchorNote,
  compareTimeline,
  dayAt,
  dayEndPosition,
  positionAt,
  prepareTrip,
} from "../src/server/ordering";
import type { Day } from "../src/shared/api";
import fixture from "./fixtures/hike.json";

const days = fixture.days as Day[];
const trip = prepareTrip(days, "Europe/Berlin");
const pt = (day: number, i: number) => days[day - 1]?.track[i] as Day["track"][number];
const at = (iso: string) => Date.parse(iso);
const note = (lat: number, lon: number, extra: Partial<Parameters<typeof anchorNote>[0]> = {}) =>
  anchorNote({ lat, lon, at: null, hint: null, created: at("2026-10-15T08:00:00Z"), ...extra }, trip);

describe("track anchors", () => {
  test("a note beside the track takes the time interpolated on the nearest segment", () => {
    const [lat, lon] = pt(1, 150);
    const a = note(lat + 0.0002, lon + 0.0002);
    expect(a.rule).toBe("track");
    expect(a.day).toBe(1);
    expect(a.off_track).toBe(false);
    // Between the vertices around index 150, not snapped to one of them.
    expect(a.t).toBeGreaterThan(at(pt(1, 149)[3]));
    expect(a.t).toBeLessThan(at(pt(1, 151)[3]));
    expect(a.t).not.toBe(at(pt(1, 150)[3]));
    expect(a.km).toBeGreaterThan(4);
    expect(a.km).toBeLessThan(5.5);
  });

  test("notes on different days order by their days, whatever their numbers", () => {
    const late = note(...(pt(4, 200).slice(0, 2) as [number, number]));
    const early = note(...(pt(2, 100).slice(0, 2) as [number, number]));
    expect(early.day).toBe(2);
    expect(late.day).toBe(4);
    expect(early.t).toBeLessThan(late.t);
  });

  // The sample hike has no stretch walked twice, so this one is synthetic: 1 km east and back.
  const outAndBack = (() => {
    const t0 = at("2026-10-17T10:00:00+02:00");
    const track: Day["track"] = [];
    for (let i = 0; i <= 20; i++) {
      const x = i <= 10 ? i : 20 - i;
      track.push([49.9, 7.5 + x * 0.0014, 300, new Date(t0 + i * 180_000).toISOString()]);
    }
    return prepareTrip([{ n: 1, date: "2026-10-17", track, stats: null, end: null, source: null }], "Europe/Berlin");
  })();
  const onIt = (hint: number | null) =>
    anchorNote({ lat: 49.9001, lon: 7.5 + 3 * 0.0014, at: null, hint, created: 0 }, outAndBack);

  test("an out-and-back stretch: the earliest pass wins without a hint", () => {
    const a = onIt(null);
    expect(Math.abs(a.t - at("2026-10-17T10:09:00+02:00"))).toBeLessThan(60_000);
  });

  test("an out-and-back stretch: a photo time picks the later pass", () => {
    const a = onIt(at("2026-10-17T10:55:00+02:00"));
    expect(Math.abs(a.t - at("2026-10-17T10:51:00+02:00"))).toBeLessThan(60_000);
  });

  test("the camp shared by two days goes to the evening, or to the morning with a morning photo", () => {
    const camp = days[0]?.end as NonNullable<Day["end"]>;
    const evening = note(camp.lat, camp.lon);
    expect(evening.day).toBe(1);
    const morning = note(camp.lat, camp.lon, { hint: at("2026-10-16T08:30:00+02:00") });
    expect(morning.day).toBe(2);
    expect(morning.t).toBeGreaterThan(evening.t);
  });

  test("more than 300 m away is flagged off track but still anchored on the track", () => {
    const [lat, lon] = pt(2, 100);
    const a = note(lat + 0.01, lon);
    expect(a.off_track).toBe(true);
    expect(a.rule).toBe("track");
    expect(a.dist_m).toBeGreaterThan(300);
  });
});

describe("other rules", () => {
  test("live trip: far from every track and created after the last point anchors at its creation", () => {
    const created = at("2026-10-20T11:28:47Z");
    const a = note(49.98, 7.68, { created });
    expect(a.rule).toBe("created");
    expect(a.t).toBe(created);
    expect(a.off_track).toBe(true);
  });

  test("near the track, a late creation time changes nothing", () => {
    const [lat, lon] = pt(5, 50);
    const a = note(lat, lon, { created: at("2026-10-20T11:28:47Z") });
    expect(a.rule).toBe("track");
    expect(a.day).toBe(5);
  });

  test("a manual time overrides the track", () => {
    const [lat, lon] = pt(2, 100);
    const a = note(lat, lon, { at: at("2026-10-18T12:00:00+02:00") });
    expect(a.rule).toBe("at");
    expect(a.t).toBe(at("2026-10-18T12:00:00+02:00"));
    expect(a.day).toBe(4);
  });

  test("a note without a place stands at its time, on the day of that time", () => {
    // Day 2's track runs in the morning; the evening after it still belongs to day 2.
    const evening = at(`${days[1]?.date}T21:30:00+02:00`);
    const a = anchorNote({ lat: null, lon: null, at: evening, hint: null, created: at("2026-10-20T08:00:00Z") }, trip);
    expect(a).toEqual({ t: evening, rule: "at", day: 2, dist_m: null, km: null, off_track: false });
    const inside = at(pt(3, 100)[3]);
    expect(anchorNote({ lat: null, lon: null, at: inside, hint: null, created: inside }, trip).day).toBe(3);
  });

  test("a day ends at its last track point", () => {
    const a = anchorDayEnd(3, trip);
    expect(a.rule).toBe("day-end");
    expect(a.t).toBe(at(pt(3, (days[2]?.track.length as number) - 1)[3]));
    expect(a.km).toBeCloseTo(10.61, 1);
  });

  test("a rest day ends at 18:00 local time and stands at the previous camp", () => {
    const rest = prepareTrip(
      [...days, { n: 6, date: "2026-10-20", track: [], stats: null, end: null, source: null }],
      "Europe/Berlin",
    );
    const a = anchorDayEnd(6, rest);
    expect(a.rule).toBe("rest-day");
    expect(a.t).toBe(at("2026-10-20T18:00:00+02:00"));
    expect(dayEndPosition(6, rest)).toEqual({ lat: days[4]?.end?.lat as number, lon: days[4]?.end?.lon as number });
    expect(dayAt(at("2026-10-20T10:00:00+02:00"), rest)).toBe(6);
  });

  test("ties: time, then a numbered note before the day end, then number", () => {
    const t = 1000;
    const items = [
      { t, kind: "day" as const, number: null, day: 1 },
      { t, kind: "note" as const, number: 9, day: null },
      { t, kind: "note" as const, number: 4, day: null },
      { t: 999, kind: "note" as const, number: 12, day: null },
    ].sort(compareTimeline);
    expect(items.map((i) => i.number ?? `d${i.day}`)).toEqual([12, 4, 9, "d1"]);
  });

  test("a note at the camp sorts before that day's end", () => {
    const camp = days[0]?.end as NonNullable<Day["end"]>;
    const n = note(camp.lat, camp.lon);
    const d = anchorDayEnd(1, trip);
    const order = [
      { t: d.t, kind: "day" as const, number: null, day: 1 },
      { t: n.t, kind: "note" as const, number: 30, day: null },
    ].sort(compareTimeline);
    expect(order[0]?.kind).toBe("note");
  });

  test("the position at a time is interpolated on that day's track", () => {
    const p = positionAt(at(pt(1, 150)[3]), trip);
    expect(p?.day).toBe(1);
    expect(p?.lat).toBeCloseTo(pt(1, 150)[0], 5);
    expect(positionAt(at("2026-10-15T08:00:00+02:00"), trip)).toBeNull();
  });
});
