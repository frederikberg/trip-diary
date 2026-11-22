import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import stations from "../src/server/stations.json";
import { createTravel, fastest, TravelError } from "../src/server/travel";
import type { Entry, MapCreated, MapView, MeetState } from "../src/shared/api";
import { fakeGeocoder, fakeImmich, fakeRouters, testApp } from "./helpers";

const immich = fakeImmich();
const geo = fakeGeocoder();
const routers = fakeRouters();
afterAll(() => {
  immich.stop();
  geo.stop();
  routers.stop();
});
beforeEach(() => {
  routers.carRequests.length = 0;
  routers.trainRequests.length = 0;
  routers.carFails = null;
  routers.trainFails = null;
  routers.noJourney.clear();
});

const eva = (name: string) => (stations.find((s) => s.name === name) as { eva: string }).eva;
const place = (lat: number, lon: number, label = "Zuhause") => ({ label, address: `${lat}`, lat, lon });

async function setup(over: Parameters<typeof testApp>[3] = {}) {
  const app = testApp(immich.url, null, undefined, {
    meet: { car_url: routers.carUrl, train_url: routers.trainUrl },
    ...over,
  });
  const made = (await (
    await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "M" } })
  ).json()) as MapCreated;
  const base = `/api/m/${made.edit.token}`;
  const add = async (name: string, ...places: unknown[]) =>
    (await (await app.call(`${base}/entries`, { method: "POST", json: { name, places } })).json()) as Entry;
  const put = (id: number, json: unknown) => app.call(`${base}/meet/members/${id}`, { method: "PUT", json });
  const state = async () => (await (await app.call(`${base}/meet`)).json()) as MeetState;
  const compute = async () => {
    const res = await app.call(`${base}/meet/compute`, { method: "POST" });
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (!s.job || s.job.error) return { res, s };
      await Bun.sleep(5);
    }
    throw new Error("the job did not end");
  };
  return { app, made, base, add, put, state, compute };
}

describe("the selection", () => {
  test("a new member defaults, and a change keeps the rest", async () => {
    const { add, put, state } = await setup();
    const a = await add("A", place(50, 6));
    expect((await put(a.id, {})).status).toBe(200);
    await put(a.id, { weight: 3 });
    await put(a.id, { mode: "train" });
    expect((await state()).members).toMatchObject([{ entry_id: a.id, weight: 3, mode: "train", place_id: null }]);
  });

  test("validation", async () => {
    const { add, put, app, base } = await setup();
    const a = await add("A", place(50, 6));
    const none = await add("Ohne");
    expect((await put(a.id, { weight: 0 })).status).toBe(400);
    expect((await put(a.id, { weight: 5 })).status).toBe(400);
    expect((await put(a.id, { mode: "boot" })).status).toBe(400);
    expect((await put(a.id, { place_id: "nope" })).status).toBe(400);
    expect((await put(a.id, { extra: 1 })).status).toBe(400);
    expect((await put(none.id, {})).status).toBe(400);
    expect((await put(9999, {})).status).toBe(404);
    expect((await app.call(`${base}/meet/members/${a.id}`, { method: "DELETE" })).status).toBe(200);
  });

  test("the selection has a limit; members already in can still change", async () => {
    const { add, put } = await setup({
      meet: { car_url: routers.carUrl, train_url: routers.trainUrl, max_members: 1 },
    });
    const a = await add("A", place(50, 6));
    const b = await add("B", place(51, 7));
    expect((await put(a.id, {})).status).toBe(200);
    expect((await put(b.id, {})).status).toBe(409);
    expect((await put(a.id, { weight: 2 })).status).toBe(200);
  });

  test("a read link reads and may not write", async () => {
    const { app, made, add } = await setup();
    const a = await add("A", place(50, 6));
    const t = `/api/m/${made.view.token}`;
    expect((await app.call(`${t}/meet`)).status).toBe(200);
    expect((await app.call(`${t}/meet/members/${a.id}`, { method: "PUT", json: {} })).status).toBe(403);
    expect((await app.call(`${t}/meet/compute`, { method: "POST" })).status).toBe(403);
  });

  test("every change reaches open pages and the view inlines the state", async () => {
    const { app, base, add, put } = await setup();
    const a = await add("A", place(50, 6));
    const first = await app.call(base);
    const etag = first.headers.get("etag") as string;
    await put(a.id, {});
    const next = await app.call(base, { headers: { "if-none-match": etag } });
    expect(next.status).toBe(200);
    expect(((await next.json()) as MapView).meet.members).toHaveLength(1);
  });

  test("the middle is there from two members and follows the weight", async () => {
    const { add, put, state } = await setup();
    const a = await add("A", place(50, 8));
    const b = await add("B", place(50, 12));
    await put(a.id, {});
    expect((await state()).centroid).toBeNull();
    await put(b.id, { weight: 3 });
    expect((await state()).centroid?.lon).toBeCloseTo(11, 1);
  });

  test("a deleted entry leaves the selection and returns with it", async () => {
    const { app, base, add, put, state } = await setup();
    const a = await add("A", place(50, 8));
    await put(a.id, {});
    await app.call(`${base}/entries/${a.id}`, { method: "DELETE" });
    expect((await state()).members).toEqual([]);
    await app.call(`${base}/entries/${a.id}/restore`, { method: "POST", json: {} });
    expect((await state()).members).toHaveLength(1);
  });

  test("the admin mirrors the routes", async () => {
    const { app, add, state } = await setup();
    const a = await add("A", place(50, 8));
    const res = await app.call(`/api/admin/maps/m/meet/members/${a.id}`, { method: "PUT", admin: true, json: {} });
    expect(res.status).toBe(200);
    expect((await state()).members).toHaveLength(1);
    expect((await app.call("/api/admin/maps/m/meet", { admin: true })).status).toBe(200);
  });
});

/** Köln by train, Hannover by car, München by train from outside town. */
async function trio(over?: Parameters<typeof testApp>[3]) {
  const s = await setup(over);
  const koeln = await s.add("Köln", place(50.94, 6.96));
  const hannover = await s.add("Hannover", place(52.37, 9.74));
  const muenchen = await s.add("München", place(48.35, 11.2));
  await s.put(koeln.id, { mode: "train", weight: 2 });
  await s.put(hannover.id, { mode: "car" });
  await s.put(muenchen.id, { mode: "train" });
  return { ...s, koeln, hannover, muenchen };
}

describe("computing", () => {
  test("needs two members, and one job at a time", async () => {
    const { app, base, add, put } = await setup();
    const a = await add("A", place(50, 6));
    await put(a.id, {});
    expect((await app.call(`${base}/meet/compute`, { method: "POST" })).status).toBe(400);
    const b = await add("B", place(52, 9));
    await put(b.id, {});
    const first = await app.call(`${base}/meet/compute`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(((await first.json()) as MeetState).job?.error).toBeNull();
    expect((await app.call(`${base}/meet/compute`, { method: "POST" })).status).toBe(409);
  });

  test("ranks three stations with a leg for everybody", async () => {
    const { compute, koeln, hannover, muenchen } = await trio();
    const { res, s } = await compute();
    expect(res.status).toBe(202);
    const r = s.result;
    expect(r?.candidates).toHaveLength(3);
    expect(r?.train_ok).toBe(true);
    const scores = r?.candidates.map((c) => c.score) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    const best = r?.candidates[0];
    const leg = (id: number) => best?.legs.find((l) => l.entry_id === id);
    expect(leg(koeln.id)).toMatchObject({ by: "train", station: "Köln Hbf", access_min: 0 });
    expect(leg(hannover.id)).toMatchObject({ by: "car", station: null });
    expect(leg(muenchen.id)?.by).toBe("train");
    expect(leg(muenchen.id)?.access_min).toBeGreaterThan(0);
    expect(new Date(r?.departure as string).getUTCDay()).toBe(6);
    expect(s.stale).toBe(false);
  });

  test("a bus does not count as the fastest train", async () => {
    const { compute } = await trio();
    const { s } = await compute();
    const train = s.result?.candidates[0]?.legs[0];
    expect(train?.minutes).toBeGreaterThan(60);
  });

  test("the 10 km rule: 0 minutes just inside, a car ride just outside", async () => {
    const { add, put, compute } = await setup();
    const hbf = stations.find((s) => s.name === "Kassel-Wilhelmshöhe") as { lat: number; lon: number };
    const inside = await add("In", place(hbf.lat + 9.5 / 111, hbf.lon));
    const outside = await add("Out", place(hbf.lat - 10.5 / 111, hbf.lon));
    await put(inside.id, { mode: "train" });
    await put(outside.id, { mode: "train" });
    const { s } = await compute();
    const legs = s.result?.candidates[0]?.legs;
    expect(legs?.find((l) => l.entry_id === inside.id)?.access_min).toBe(0);
    expect(legs?.find((l) => l.entry_id === outside.id)?.access_min).toBeGreaterThan(0);
  });

  test("no journey falls back to the car, for that person and place", async () => {
    const { compute, koeln } = await trio();
    routers.noJourney.add(`${eva("Köln Hbf")}>${eva("Kassel-Wilhelmshöhe")}`);
    for (const c of stations) routers.noJourney.add(`${eva("Köln Hbf")}>${c.eva}`);
    const { s } = await compute();
    expect(s.result?.candidates.every((c) => c.legs.find((l) => l.entry_id === koeln.id)?.by === "car-fallback")).toBe(
      true,
    );
    expect(s.result?.train_ok).toBe(true);
  });

  test("a dead train service: everybody by car, and the result says so", async () => {
    const { compute } = await trio();
    routers.trainFails = 503;
    const { s } = await compute();
    expect(s.result?.train_ok).toBe(false);
    expect(s.result?.notes.join()).toContain("alle per Auto");
    expect(s.result?.candidates[0]?.legs.filter((l) => l.by === "train")).toEqual([]);
    expect(routers.trainRequests).toHaveLength(1);
  });

  // Two full jobs and the start of a third: past the default 5 s on a slow runner.
  test("a dead car router ends the job with an error, the old result stays", async () => {
    const { compute, app, base, koeln, state } = await trio();
    const { s: first } = await compute();
    await app.call(`${base}/entries/${koeln.id}`, { method: "PATCH", json: { places: [place(50.5, 7.5)] } });
    routers.carFails = 502;
    const { s } = await compute();
    expect(s.job?.error).toContain("Fahrzeiten");
    expect(s.result?.computed_at).toBe(first.result?.computed_at as string);
    routers.carFails = null;
    const again = await app.call(`${base}/meet/compute`, { method: "POST" });
    expect(again.status).toBe(202);
    for (let i = 0; i < 100 && (await state()).job; i++) await Bun.sleep(5);
  }, 15_000);

  test("stale, then fresh", async () => {
    const { compute, put, state, koeln, app, base } = await trio();
    await compute();
    await put(koeln.id, { weight: 3 });
    expect((await state()).stale).toBe(true);
    await compute();
    expect((await state()).stale).toBe(false);
    await app.call(`${base}/entries/${koeln.id}`, {
      method: "PATCH",
      json: { places: [place(51.5, 7.4)] },
    });
    expect((await state()).stale).toBe(true);
  });

  test("a second run reuses the train times", async () => {
    const { compute } = await trio();
    await compute();
    const asked = routers.trainRequests.length;
    expect(asked).toBeGreaterThan(0);
    await compute();
    expect(routers.trainRequests).toHaveLength(asked);
  });

  test("far from every station the result says so", async () => {
    const { add, put, compute } = await setup();
    const a = await add("Kopenhagen", place(55.68, 12.57));
    const b = await add("Berlin", place(52.5, 13.4));
    await put(a.id, { mode: "train" });
    await put(b.id, { mode: "train" });
    const { s } = await compute();
    expect(s.result?.notes.join()).toContain("Kopenhagen:");
    expect(s.result?.notes.join()).toContain("Anfahrt");
  });

  test("outside the radius the car ride picks the home station, not the map", async () => {
    const { add, put, compute } = await setup();
    const a = await add("Küste", place(54.2, 13.0));
    const b = await add("Berlin", place(52.5, 13.4));
    await put(a.id, { mode: "train" });
    await put(b.id, { mode: "train" });
    const { s } = await compute();
    const leg = s.result?.candidates[0]?.legs.find((l) => l.entry_id === a.id);
    expect(leg?.station).toBe("Stralsund Hbf");
    expect(leg?.access_min).toBeGreaterThan(0);
  });

  test("everybody sees the result in the map view", async () => {
    const { compute, app, made } = await trio();
    await compute();
    const v = (await (await app.call(`/api/m/${made.view.token}`)).json()) as MapView;
    expect(v.meet.result?.candidates).toHaveLength(3);
  });
});

describe("travel", () => {
  const app = testApp(immich.url, null, undefined, { meet: { car_url: routers.carUrl, train_url: routers.trainUrl } });
  const travel = () => createTravel(app.config, app.store, "trip-diary/test");

  test("the fastest journey skips buses, unless there is nothing else", () => {
    const j = (s: number, k: string) => ({ verbindung: { reiseDauer: s, verbindungsAbschnitte: [{ kurztext: k }] } });
    expect(fastest([j(60, "Bus"), j(600, "ICE")])).toBe(10);
    expect(fastest([j(60, "Bus")])).toBe(1);
    expect(fastest([])).toBeNull();
  });

  test("car times are cached, and more coordinates than a table takes are split", async () => {
    const t = travel();
    const sources = [{ lat: 40.1, lon: 6 }];
    const destinations = Array.from({ length: 120 }, (_, i) => ({ lat: 41 + i / 100, lon: 7 }));
    const m = await t.carMatrix(sources, destinations);
    expect(m[0]).toHaveLength(120);
    expect(routers.carRequests).toHaveLength(2);
    await t.carMatrix(sources, destinations);
    expect(routers.carRequests).toHaveLength(2);
  });

  test("no connection is cached too; a failure is not", async () => {
    const t = travel();
    const [a, b] = [eva("Fulda"), eva("Konstanz")];
    routers.noJourney.add(`${a}>${b}`);
    expect(await t.trainMinutes(a, b, "2026-11-07T09:00:00+01:00")).toBeNull();
    expect(await t.trainMinutes(a, b, "2026-11-07T09:00:00+01:00")).toBeNull();
    expect(routers.trainRequests).toHaveLength(1);
    expect(routers.trainRequests[0]?.userAgent).toBe("trip-diary/test");
    routers.trainFails = 500;
    const c = eva("Passau Hbf");
    expect(t.trainMinutes(b, c, "2026-11-07T09:00:00+01:00")).rejects.toBeInstanceOf(TravelError);
  });

  test("no connection is asked again after a day, a time is not", async () => {
    let at = new Date("2026-11-02T10:00:00Z");
    const t = createTravel(app.config, app.store, "x", () => at);
    const [a, b, c] = [eva("Lüneburg"), eva("Bamberg"), eva("Offenburg")];
    routers.noJourney.add(`${a}>${b}`);
    await t.trainMinutes(a, b, "x");
    await t.trainMinutes(a, c, "x");
    at = new Date(at.getTime() + 2 * 86_400_000);
    expect(t.trainCached(a, b)).toBe(false);
    expect(t.trainCached(a, c)).toBe(true);
  });

  test("car requests keep their distance", async () => {
    const spaced = testApp(immich.url, null, undefined, {
      meet: { car_url: routers.carUrl, train_url: routers.trainUrl, car_interval_ms: 40 },
    });
    const t = createTravel(spaced.config, spaced.store, "x");
    const t0 = Date.now();
    const sources = [{ lat: 39.5, lon: 6 }];
    await t.carMatrix(
      sources,
      Array.from({ length: 150 }, (_, i) => ({ lat: 38 + i / 100, lon: 7 })),
    );
    expect(routers.carRequests).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(38);
  });

  test("the cache ends after its days", async () => {
    let at = new Date("2026-11-02T10:00:00Z");
    const t = createTravel(app.config, app.store, "x", () => at);
    const [a, b] = [eva("Fulda"), eva("Ulm Hbf")];
    await t.trainMinutes(a, b, "x");
    at = new Date(at.getTime() + 31 * 86_400_000);
    expect(t.trainCached(a, b)).toBe(false);
  });

  test("train requests keep their distance", async () => {
    const spaced = testApp(immich.url, null, undefined, {
      meet: { car_url: routers.carUrl, train_url: routers.trainUrl, train_interval_ms: 40 },
    });
    const t = createTravel(spaced.config, spaced.store, "x");
    const t0 = Date.now();
    await Promise.all(
      [eva("Fulda"), eva("Bamberg"), eva("Kiel Hbf")].map((from) => t.trainMinutes(from, eva("Ulm Hbf"), "x")),
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  });
});
