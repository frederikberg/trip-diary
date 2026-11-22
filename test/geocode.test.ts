import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GeocodeError, Geocoder } from "../src/server/geocode";
import type { GeoHit, MapCreated } from "../src/shared/api";
import { fakeGeocoder, fakeImmich, testApp } from "./helpers";

const geo = fakeGeocoder([
  {
    match: "Musterweg",
    lat: 52.36,
    lon: 9.75,
    street: "Musterweg",
    housenumber: "7",
    postcode: "30163",
    city: "Hannover",
    country: "Deutschland",
  },
  {
    match: "Musterstrasse",
    lat: 47.37,
    lon: 8.54,
    street: "Musterstrasse",
    postcode: "8001",
    city: "Zürich",
    country: "Schweiz",
  },
  { match: "Rathaus", lat: 50.77, lon: 6.08, name: "Rathaus", city: "Aachen", country: "Deutschland" },
  { match: "Rathaus Zwei", lat: 50.77, lon: 6.08, name: "Rathaus", city: "Aachen", country: "Deutschland" },
]);
const immich = fakeImmich();

afterAll(() => {
  geo.stop();
  immich.stop();
});

const geocoder = (perMinute = 60, now?: () => number) =>
  new Geocoder({ url: geo.url, timeoutMs: 1000, retryMs: 1, perMinute, userAgent: "trip-diary/test", now });

beforeEach(() => {
  geo.requests.length = 0;
  geo.failWith = null;
});

describe("Geocoder", () => {
  test("maps Photon's answer to hits with a Google link", async () => {
    const [hit] = await geocoder().search("t", "Musterweg 7");
    expect(hit as GeoHit).toEqual({
      label: "Musterweg 7, 30163 Hannover",
      street: "Musterweg",
      housenumber: "7",
      postcode: "30163",
      city: "Hannover",
      country: "Deutschland",
      lat: 52.36,
      lon: 9.75,
      google_url: "https://www.google.com/maps/search/?api=1&query=52.36%2C9.75",
    });
    expect(geo.requests[0]?.path).toContain("lang=de");
    expect(geo.requests[0]?.path).toContain("limit=6");
    expect(geo.requests[0]?.userAgent).toBe("trip-diary/test");
  });

  test("names the country abroad, and a place by its name", async () => {
    const g = geocoder();
    expect((await g.search("t", "Musterstrasse"))[0]?.label).toBe("Musterstrasse, 8001 Zürich, Schweiz");
    expect((await g.search("t", "Rathaus"))[0]?.label).toBe("Rathaus, Aachen");
  });

  test("the same label comes once", async () => {
    expect(await geocoder().search("t", "Rathaus Zwei")).toHaveLength(1);
  });

  test("passes a position to prefer", async () => {
    await geocoder().search("t", "Musterweg", { lat: 50, lon: 6 });
    expect(geo.requests[0]?.path).toContain("lat=50&lon=6");
  });

  test("a repeated question is answered from the cache", async () => {
    const g = geocoder();
    await g.search("t", "Musterweg");
    await g.search("other", "Musterweg");
    expect(geo.requests).toHaveLength(1);
  });

  test("the cache ends after a day", async () => {
    let t = 0;
    const g = geocoder(60, () => t);
    await g.search("t", "Musterweg");
    t = 86_400_001;
    await g.search("t", "Musterweg");
    expect(geo.requests).toHaveLength(2);
  });

  test("reverse asks for the point", async () => {
    const hits = await geocoder().reverse("t", 52.36, 9.75);
    expect(hits[0]?.street).toBe("Musterweg");
    expect(geo.requests[0]?.path).toStartWith("/reverse?lat=52.36&lon=9.75");
  });

  test("the budget is per token and per minute; cached answers are free", async () => {
    let t = 0;
    const g = geocoder(2, () => t);
    await g.search("a", "Musterweg 1");
    await g.search("a", "Musterweg 1");
    await g.search("a", "Musterweg 2");
    expect(g.search("a", "Musterweg 3")).rejects.toMatchObject({ status: 429 });
    await g.search("b", "Musterweg 3");
    t = 60_001;
    await g.search("a", "Musterweg 4");
  });

  test("one failure is tried again, and costs one from the budget", async () => {
    const g = geocoder(1);
    geo.failNext = 1;
    expect(await g.search("t", "Musterweg")).toHaveLength(1);
    expect(geo.requests).toHaveLength(2);
    expect(g.search("t", "Musterweg 9")).rejects.toMatchObject({ status: 429 });
  });

  test("a failing upstream is a 502, and is not cached", async () => {
    const g = geocoder();
    geo.failWith = 500;
    const e = await g.search("t", "Musterweg").catch((x) => x);
    expect(e).toBeInstanceOf(GeocodeError);
    expect((e as GeocodeError).status).toBe(502);
    expect((e as GeocodeError).message).not.toContain(geo.url);
    geo.failWith = null;
    expect(await g.search("t", "Musterweg")).toHaveLength(1);
  });
});

describe("geocode routes", () => {
  const app = testApp(immich.url, null, undefined, { maps: { geocoder_url: geo.url, geocode_per_minute: 3 } });
  let made: MapCreated;

  test("a view token can search, the admin too", async () => {
    made = (await (
      await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "g", title: "G" } })
    ).json()) as MapCreated;
    const res = await app.call(`/api/m/${made.view.token}/geocode?q=Musterweg`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as GeoHit[])[0]?.city).toBe("Hannover");
    const admin = await app.call("/api/admin/maps/g/geocode?lat=52&lon=9", { admin: true });
    expect(admin.status).toBe(200);
  });

  test("a short or missing question is refused", async () => {
    expect((await app.call(`/api/m/${made.view.token}/geocode?q=ab`)).status).toBe(400);
    expect((await app.call(`/api/m/${made.view.token}/geocode`)).status).toBe(400);
    expect((await app.call(`/api/m/${made.view.token}/geocode?lat=500&lon=9`)).status).toBe(400);
    expect((await app.call(`/api/m/${"x".repeat(22)}/geocode?q=Musterweg`)).status).toBe(404);
  });

  test("over the budget answers 429, a dead geocoder 502", async () => {
    const t = made.edit.token;
    expect((await app.call(`/api/m/${t}/geocode?q=Musterweg 1`)).status).toBe(200);
    geo.failWith = 503;
    expect((await app.call(`/api/m/${t}/geocode?q=Musterweg 2`)).status).toBe(502);
    expect((await app.call(`/api/m/${t}/geocode?q=Musterweg 3`)).status).toBe(502);
    expect((await app.call(`/api/m/${t}/geocode?q=Musterweg 4`)).status).toBe(429);
  });
});
