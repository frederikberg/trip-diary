// What view links hold back: admin-only fields, the trip's privacy settings, media gone from Immich.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Immich } from "../src/server/immich";
import { sweepMedia } from "../src/server/sweep";
import type { Note, TripView } from "../src/shared/api";
import { type FakeImmich, fakeImmich, IMMICH_KEY, onTrack, seedTrip, type TestApp, testApp } from "./helpers";

const PHOTO = "77777777-7777-4777-8777-777777777777";

let immich: FakeImmich;
let app: TestApp;
let s: Awaited<ReturnType<typeof seedTrip>>;

beforeAll(async () => {
  immich = fakeImmich();
  immich.assets.set(PHOTO, {
    id: PHOTO,
    type: "IMAGE",
    width: 4000,
    height: 3000,
    taken_at: "2026-10-16T09:00:00.000Z",
  });
  app = testApp(immich.url);
  s = await seedTrip(app);
  await app.call("/api/admin/trips/sample", { method: "PATCH", admin: true, json: { extra: { legacy: "x" } } });
  await app.call("/api/admin/trips/sample/days/2", {
    method: "PUT",
    admin: true,
    json: { ...(await day(2)), source: { garmin_activity_id: 123 } },
  });
  const n = (await (
    await app.call("/api/admin/trips/sample/notes", {
      method: "POST",
      admin: true,
      json: { ...onTrack(2, 0.4), created: "2026-10-16T08:00:00Z", extra: { old: 1 } },
    })
  ).json()) as Note;
  await app.call(`/api/admin/trips/sample/notes/${n.key}/media`, {
    method: "POST",
    admin: true,
    json: { immich_id: PHOTO },
  });
});
afterAll(() => immich.stop());

async function day(n: number) {
  const v = (await (await app.call("/api/admin/trips/sample", { admin: true })).json()) as TripView;
  const { n: _n, ...rest } = v.days.find((d) => d.n === n) as TripView["days"][number];
  return rest;
}
const friend = async () => (await (await app.call(`/api/t/${s.view}`)).json()) as TripView;
const editor = async () => (await (await app.call(`/api/t/${s.view}`, { editor: true })).json()) as TripView;

describe("fields only editors need", () => {
  test("view links get no extra and no day source", async () => {
    const v = await friend();
    expect(v.trip.extra).toEqual({});
    expect(v.notes.find((n) => n.key === "1")?.extra).toEqual({});
    expect(v.days.find((d) => d.n === 2)?.source).toBeNull();
    const e = await editor();
    expect(e.trip.extra).toEqual({ legacy: "x" });
    expect(e.notes.find((n) => n.key === "1")?.extra).toEqual({ old: 1 });
    expect(e.days.find((d) => d.n === 2)?.source).toEqual({ garmin_activity_id: 123 });
  });
});

describe("privacy settings", () => {
  test("nothing is held back by default", async () => {
    const v = await friend();
    expect(v.trip.privacy).toEqual({ hide_camps: false, delay_hours: 0 });
    expect(v.days[0]?.end?.camp_type).toBe("wild");
  });

  test("hide_camps drops camp type and name for view links only", async () => {
    await app.call("/api/admin/trips/sample", {
      method: "PATCH",
      admin: true,
      json: { privacy: { hide_camps: true } },
    });
    const v = await friend();
    expect(v.days.every((d) => d.end?.camp_type == null && d.end?.name == null)).toBe(true);
    expect(v.days[0]?.end?.lat).toBeGreaterThan(49);
    expect((await editor()).days[0]?.end?.name).toBe("Wildcamp Tag 1");
    await app.call("/api/admin/trips/sample", {
      method: "PATCH",
      admin: true,
      json: { privacy: { hide_camps: false } },
    });
  });

  test("delay_hours keeps fresh notes from view links", async () => {
    const fresh = (await (
      await app.call(`/api/t/${s.view}/notes`, { method: "POST", editor: true, json: { lat: 49.9, lon: 7.6 } })
    ).json()) as Note;
    expect((await friend()).notes.some((n) => n.key === fresh.key)).toBe(true);
    await app.call("/api/admin/trips/sample", { method: "PATCH", admin: true, json: { privacy: { delay_hours: 6 } } });
    expect((await friend()).notes.some((n) => n.key === fresh.key)).toBe(false);
    expect((await friend()).notes.some((n) => n.key === "1")).toBe(true);
    expect((await editor()).notes.some((n) => n.key === fresh.key)).toBe(true);
    await app.call("/api/admin/trips/sample", { method: "PATCH", admin: true, json: { privacy: { delay_hours: 0 } } });
  });

  test("bad privacy values are refused", async () => {
    const r = await app.call("/api/admin/trips/sample", {
      method: "PATCH",
      admin: true,
      json: { privacy: { hide_camps: "yes" } },
    });
    expect(r.status).toBe(400);
  });
});

describe("media trashed in Immich", () => {
  const sweep = () =>
    sweepMedia(
      app.store,
      new Immich(immich.url, IMMICH_KEY, {
        timeoutMs: 2000,
        bodyTimeoutMs: 60_000,
        previewSize: 1440,
        albumsMs: 600_000,
      }),
      () => new Date(),
    );

  test("disappear from view links after a sweep, and come back when restored", async () => {
    const before = (await friend()).notes.find((n) => n.key === "1")?.media.length;
    expect(before).toBe(1);
    const m = (await editor()).notes.find((n) => n.key === "1")?.media[0];
    (immich.assets.get(PHOTO) as { trashed?: boolean }).trashed = true;
    await sweep();
    expect((await friend()).notes.find((n) => n.key === "1")?.media.length).toBe(0);
    expect((await app.call(`/api/t/${s.view}/m/${m?.id}/preview`)).status).toBe(404);
    const e = (await editor()).notes.find((n) => n.key === "1")?.media[0];
    expect(e?.unavailable_at).toBeTruthy();
    (immich.assets.get(PHOTO) as { trashed?: boolean }).trashed = false;
    await sweep();
    expect((await friend()).notes.find((n) => n.key === "1")?.media.length).toBe(1);
  });

  test("an unreachable Immich changes nothing", async () => {
    const down = new Immich("http://127.0.0.1:9", IMMICH_KEY, {
      timeoutMs: 500,
      bodyTimeoutMs: 1000,
      previewSize: 1440,
      albumsMs: 600_000,
    });
    await sweepMedia(app.store, down, () => new Date());
    expect((await friend()).notes.find((n) => n.key === "1")?.media.length).toBe(1);
  });
});
