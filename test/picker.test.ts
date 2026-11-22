// The editor's photo picker: the time-window search and thumbnails of assets no note carries yet.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Immich } from "../src/server/immich";
import { sweepMedia } from "../src/server/sweep";
import type { Note, Suggestion } from "../src/shared/api";
import { type FakeAsset, type FakeImmich, fakeImmich, IMMICH_KEY, seedTrip, type TestApp, testApp } from "./helpers";

const PHOTO = "77777777-7777-4777-8777-777777777777";
const VIDEO = "88888888-8888-4888-8888-888888888888";
const LIVE = "99999999-9999-4999-8999-999999999999";

let immich: FakeImmich;
let app: TestApp;
let s: Awaited<ReturnType<typeof seedTrip>>;
// A day whose track is not recorded yet: today, far from every track.
const today = Math.floor(Date.now() / 1000) * 1000 - 3 * 3_600_000;

beforeAll(async () => {
  immich = fakeImmich();
  const asset = (id: string, type: "IMAGE" | "VIDEO", taken_at: string) =>
    immich.assets.set(id, { id, type, width: 4000, height: 3000, taken_at, duration_ms: 9_000 });
  asset(VIDEO, "VIDEO", "2026-10-16T09:30:00.000Z");
  asset(PHOTO, "IMAGE", "2026-10-16T09:00:00.000Z");
  asset(LIVE, "IMAGE", new Date(today + 600_000).toISOString());
  app = testApp(immich.url);
  s = await seedTrip(app);
});
afterAll(() => immich.stop());

const picker = (path: string, editor = true) => app.call(`/api/t/${s.view}${path}`, { editor });
const span = (from: string, to: string) => `/suggest?${new URLSearchParams({ from, to })}`;

describe("the picker's search", () => {
  test("lists the assets of a window oldest first, videos with their length, and what carries them", async () => {
    const n = (await (
      await app.call(`/api/t/${s.view}/notes`, {
        method: "POST",
        editor: true,
        json: { lat: null, lon: null, at: "2026-10-16T11:00:00+02:00" },
      })
    ).json()) as Note;
    await app.call(`/api/t/${s.view}/notes/${n.key}/media`, {
      method: "POST",
      editor: true,
      json: { immich_id: VIDEO },
    });
    const r = await picker(span("2026-10-16T08:00:00Z", "2026-10-16T12:00:00Z"));
    expect(r.status).toBe(200);
    const list = (await r.json()) as Suggestion[];
    expect(list.map((x) => [x.immich_id, x.type, x.duration_ms, x.attached_to])).toEqual([
      [PHOTO, "image", null, []],
      [VIDEO, "video", 9_000, [n.key]],
    ]);
  });

  test("is the editor's only", async () => {
    expect((await picker("/suggest", false)).status).toBe(403);
    const other = await app.fetch(
      new Request(`${app.config.server.edit_url}/api/t/${s.view}/suggest`, {
        headers: { "x-auth-request-email": "someone@example.org" },
      }),
    );
    expect(other.status).toBe(403);
  });

  test("reaches today once a note stands there, though no track does yet", async () => {
    const from = new Date(today - 3_600_000).toISOString();
    const to = new Date(today + 3_600_000).toISOString();
    expect(((await (await picker(span(from, to))).json()) as Suggestion[]).length).toBe(0);
    await app.call(`/api/t/${s.view}/notes`, {
      method: "POST",
      editor: true,
      json: { lat: 52.5, lon: 13.4, created: new Date(today).toISOString() },
    });
    const list = (await (await picker(span(from, to))).json()) as Suggestion[];
    expect(list.map((x) => x.immich_id)).toEqual([LIVE]);
  });
});

describe("the picker's thumbnails", () => {
  test("an asset no note carries comes through for the editor, with the key kept here", async () => {
    immich.requests.length = 0;
    const r = await picker(`/immich/${PHOTO}/thumb`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(immich.requests.at(-1)?.path).toStartWith(`/api/assets/${PHOTO}/thumbnail?size=thumbnail`);
    expect(immich.requests.at(-1)?.key).toBe(IMMICH_KEY);
    expect(await r.text()).not.toContain(IMMICH_KEY);
  });

  test("nobody else gets one, and only a real asset id is asked for", async () => {
    immich.requests.length = 0;
    expect((await picker(`/immich/${PHOTO}/thumb`, false)).status).toBe(403);
    expect((await picker("/immich/..%2f..%2fsearch/thumb")).status).toBe(400);
    expect((await picker(`/immich/${PHOTO}/preview`)).status).toBe(404);
    expect(immich.requests.length).toBe(0);
  });

  test("an asset Immich does not have shows the placeholder", async () => {
    const r = await picker("/immich/00000000-0000-4000-8000-000000000000/thumb");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("photos from shared albums", () => {
  const OWN = "a0000000-0000-4000-8000-000000000001";
  const FRIEND = "a0000000-0000-4000-8000-000000000002";
  const FRIEND_NO_GPS = "a0000000-0000-4000-8000-000000000003";
  const FRIEND_LATER = "a0000000-0000-4000-8000-000000000004";
  const STRANGER = "a0000000-0000-4000-8000-000000000005";
  const FRIEND_2025 = "a0000000-0000-4000-8000-000000000006";
  const SHARED = "b0000000-0000-4000-8000-000000000001";
  const OLD = "b0000000-0000-4000-8000-000000000002";
  const window = span("2026-10-18T10:00:00Z", "2026-10-18T14:00:00Z");

  let fake: FakeImmich;
  let a2: TestApp;
  let view: string;
  const ids = async (path = window) =>
    ((await (await a2.call(`/api/t/${view}${path}`, { editor: true })).json()) as Suggestion[]).map((x) => x.immich_id);
  const albumCalls = (f: FakeImmich) => f.requests.filter((r) => r.path.startsWith("/api/albums")).length;
  const asset = (f: FakeImmich, id: string, taken_at: string, more: Partial<FakeAsset> = {}) =>
    f.assets.set(id, { id, type: "IMAGE", width: 4000, height: 3000, taken_at, ...more });

  beforeAll(async () => {
    fake = fakeImmich();
    asset(fake, OWN, "2026-10-18T11:00:00.000Z");
    asset(fake, FRIEND, "2026-10-18T11:30:00.000Z", { foreign: true, lat: 50.1, lon: 7.7 });
    asset(fake, FRIEND_NO_GPS, "2026-10-18T12:00:00.000Z", { foreign: true });
    asset(fake, FRIEND_LATER, "2026-10-18T20:00:00.000Z", { foreign: true });
    asset(fake, STRANGER, "2026-10-18T11:45:00.000Z", { foreign: true });
    asset(fake, FRIEND_2025, "2025-05-01T10:00:00.000Z", { foreign: true });
    fake.albums.set(SHARED, [OWN, FRIEND, FRIEND_NO_GPS, FRIEND_LATER]);
    fake.albums.set(OLD, [FRIEND_2025]);
    a2 = testApp(fake.url);
    view = (await seedTrip(a2)).view;
  });
  afterAll(() => fake.stop());

  test("the window lists what shared albums hold beside the own assets, each once, GPS or not", async () => {
    fake.requests.length = 0;
    expect(await ids()).toEqual([OWN, FRIEND, FRIEND_NO_GPS]);
    const search = JSON.stringify(fake.requests.find((r) => r.path === "/api/search/metadata")?.body);
    expect(search).toContain(SHARED);
    expect(search).not.toContain(OLD);
  });

  test("the album list is asked once and kept", async () => {
    fake.requests.length = 0;
    await ids();
    await ids(span("2026-10-18T09:00:00Z", "2026-10-18T13:00:00Z"));
    expect(albumCalls(fake)).toBe(0);
  });

  test("a friend's photo comes through the picker's thumbnail and attaches to a note, with or without GPS", async () => {
    const thumb = await a2.call(`/api/t/${view}/immich/${FRIEND}/thumb`, { editor: true });
    expect(thumb.headers.get("cache-control")).toBe("private, max-age=86400");
    const n = (await (
      await a2.call(`/api/t/${view}/notes`, { method: "POST", editor: true, json: { lat: 50.1, lon: 7.7 } })
    ).json()) as Note;
    for (const id of [FRIEND, FRIEND_NO_GPS]) {
      const r = await a2.call(`/api/t/${view}/notes/${n.key}/media`, {
        method: "POST",
        editor: true,
        json: { immich_id: id },
      });
      expect(r.status).toBe(201);
    }
    const media = ((await (await a2.call(`/api/t/${view}/notes/${n.key}`, { editor: true })).json()) as Note).media;
    expect(media.map((m) => [m.immich_id, m.lat])).toEqual([
      [FRIEND, 50.1],
      [FRIEND_NO_GPS, null],
    ]);
    // Taken out of the album, the friend's photo is out of reach and the sweep marks it.
    fake.albums.set(SHARED, [OWN, FRIEND_NO_GPS, FRIEND_LATER]);
    const immich = new Immich(fake.url, IMMICH_KEY, {
      timeoutMs: 2000,
      bodyTimeoutMs: 60_000,
      previewSize: 1440,
      albumsMs: 600_000,
    });
    expect(await sweepMedia(a2.store, immich, () => new Date())).toBe(1);
    const after = ((await (await a2.call(`/api/t/${view}/notes/${n.key}`, { editor: true })).json()) as Note).media;
    expect(after.map((m) => m.unavailable_at != null)).toEqual([true, false]);
    fake.albums.set(SHARED, [OWN, FRIEND, FRIEND_NO_GPS, FRIEND_LATER]);
    expect(await sweepMedia(a2.store, immich, () => new Date())).toBe(1);
  });

  test("an album unshared since the list was fetched leaves the own assets, and the list is asked again", async () => {
    fake.albums.delete(SHARED);
    fake.requests.length = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await ids()).toEqual([OWN]);
      expect(albumCalls(fake)).toBe(0);
      await ids();
      expect(albumCalls(fake)).toBe(1);
    } finally {
      warn.mockRestore();
      fake.albums.set(SHARED, [OWN, FRIEND, FRIEND_NO_GPS, FRIEND_LATER]);
    }
  });

  test("a key without album.read gives the own assets, says so once in the log and does not ask again", async () => {
    const f = fakeImmich();
    asset(f, OWN, "2026-10-18T11:00:00.000Z");
    asset(f, FRIEND, "2026-10-18T11:30:00.000Z", { foreign: true });
    f.albums.set(SHARED, [FRIEND]);
    f.albumRead = false;
    const a3 = testApp(f.url);
    const v3 = (await seedTrip(a3)).view;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        const r = await a3.call(`/api/t/${v3}${window}`, { editor: true });
        expect(r.status).toBe(200);
        expect(((await r.json()) as Suggestion[]).map((x) => x.immich_id)).toEqual([OWN]);
      }
      expect(albumCalls(f)).toBe(1);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("album.read")]);
    } finally {
      warn.mockRestore();
      f.stop();
    }
  });
});
