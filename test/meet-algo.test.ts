import { describe, expect, test } from "bun:test";
import {
  inBox,
  inputsHash,
  kmBetween,
  meanMinutes,
  nearest,
  nextDeparture,
  score,
  weightedMiddle,
} from "../src/server/meet-algo";

describe("weightedMiddle", () => {
  test("weights pull the middle: 3 to 1 lies three quarters of the way", () => {
    const m = weightedMiddle([
      { lat: 50, lon: 8, weight: 1 },
      { lat: 50, lon: 12, weight: 3 },
    ]);
    expect(m?.lon).toBeCloseTo(11, 1);
  });

  test("equal weights lie in the middle, one point has none", () => {
    const m = weightedMiddle([
      { lat: 48, lon: 10, weight: 2 },
      { lat: 52, lon: 10, weight: 2 },
    ]);
    expect(m?.lat).toBeCloseTo(50, 1);
    expect(weightedMiddle([{ lat: 48, lon: 10, weight: 2 }])).toBeNull();
  });
});

describe("score", () => {
  test("squares prefer two middling trips to one long one", () => {
    const even = score([
      { weight: 1, minutes: 60 },
      { weight: 1, minutes: 60 },
    ]);
    const lopsided = score([
      { weight: 1, minutes: 20 },
      { weight: 1, minutes: 100 },
    ]);
    expect(even).toBeLessThan(lopsided);
  });

  test("weight counts, a missing way costs a day", () => {
    expect(score([{ weight: 2, minutes: 10 }])).toBe(200);
    expect(score([{ weight: 1, minutes: null }])).toBe(1440 ** 2);
    expect(
      meanMinutes([
        { weight: 3, minutes: 100 },
        { weight: 1, minutes: 20 },
        { weight: 5, minutes: null },
      ]),
    ).toBe(80);
  });
});

describe("stations", () => {
  const list = [
    { name: "A", lat: 50, lon: 6 },
    { name: "B", lat: 52, lon: 13 },
  ];

  test("nearest", () => {
    expect(nearest({ lat: 51.9, lon: 12 }, list).name).toBe("B");
  });

  test("the box widens by the distance", () => {
    expect(inBox(list, [{ lat: 50, lon: 7 }], 100).map((s) => s.name)).toEqual(["A"]);
    expect(inBox(list, [{ lat: 50, lon: 7 }], 50)).toEqual([]);
  });

  test("distance", () => {
    expect(kmBetween({ lat: 50, lon: 6 }, { lat: 51, lon: 6 })).toBeCloseTo(111, 0);
  });
});

describe("inputsHash", () => {
  const a = { entry_id: 1, weight: 2, mode: "car", lat: 50, lon: 6 };
  const b = { entry_id: 2, weight: 1, mode: "train", lat: 51, lon: 7 };

  test("ignores the order, sees every field", () => {
    expect(inputsHash([a, b])).toBe(inputsHash([b, a]));
    for (const change of [{ weight: 3 }, { mode: "train" }, { lat: 50.1 }, { lon: 6.1 }])
      expect(inputsHash([{ ...a, ...change }, b])).not.toBe(inputsHash([a, b]));
  });
});

describe("nextDeparture", () => {
  const at = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });

  test("the next Saturday at nine, Berlin time", () => {
    expect(at(nextDeparture(new Date("2026-11-02T18:00:00Z"), 6, 9))).toBe("2026-11-07 09:00:00");
  });

  test("a Saturday after nine means the next one; across the clock change too", () => {
    expect(at(nextDeparture(new Date("2026-11-07T12:00:00Z"), 6, 9))).toBe("2026-11-14 09:00:00");
    expect(at(nextDeparture(new Date("2026-10-20T12:00:00Z"), 7, 9))).toBe("2026-10-25 09:00:00");
  });
});
