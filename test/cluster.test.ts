import { describe, expect, test } from "bun:test";
import { centroid, cluster, fanOut } from "../web/map/cluster";

describe("cluster", () => {
  test("points within the radius group, far ones do not", () => {
    const groups = cluster(
      [
        { key: "a", x: 0, y: 0 },
        { key: "b", x: 30, y: 0 },
        { key: "c", x: 200, y: 0 },
      ],
      44,
    );
    expect(groups).toEqual([["a", "b"], ["c"]]);
  });

  test("the radius counts from the group's first point", () => {
    const groups = cluster(
      [
        { key: "a", x: 0, y: 0 },
        { key: "b", x: 40, y: 0 },
        { key: "c", x: 80, y: 0 },
      ],
      44,
    );
    expect(groups).toEqual([["a", "b"], ["c"]]);
  });

  test("the same points group the same way", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ key: String(i), x: (i * 37) % 300, y: (i * 91) % 300 }));
    expect(cluster(pts, 44)).toEqual(cluster(pts, 44));
  });

  test("the centroid is the middle", () => {
    expect(
      centroid([
        { lat: 50, lon: 6 },
        { lat: 52, lon: 8 },
      ]),
    ).toEqual({ lat: 51, lon: 7 });
  });

  test("places at one address stand side by side, centred, in the given order", () => {
    const fan = fanOut(
      [
        { key: "anja", lat: 52.4229192, lon: 9.8144382 },
        { key: "oma", lat: 52.3660893, lon: 9.7713669 },
        { key: "ludger", lat: 52.4229192, lon: 9.8144382 },
        { key: "maja", lat: 52.42292, lon: 9.81444 },
      ],
      15,
      52,
      6,
    );
    expect([...fan.entries()]).toEqual([
      ["anja", { spot: 0, dx: -52 }],
      ["ludger", { spot: 0, dx: 0 }],
      ["maja", { spot: 0, dx: 52 }],
    ]);
  });

  test("a place alone, one farther than the distance, and a crowded spot get no offset", () => {
    const crowd = Array.from({ length: 7 }, (_, i) => ({ key: `c${i}`, lat: 50, lon: 6 }));
    const fan = fanOut([{ key: "a", lat: 51, lon: 7 }, { key: "b", lat: 51.0003, lon: 7 }, ...crowd], 15, 52, 6);
    expect(fan.size).toBe(0);
  });
});
