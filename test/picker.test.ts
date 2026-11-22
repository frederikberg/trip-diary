// The editor's photo picker: the time-window search and thumbnails of assets no note carries yet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Note, Suggestion } from "../src/shared/api";
import { type FakeImmich, fakeImmich, IMMICH_KEY, seedTrip, type TestApp, testApp } from "./helpers";

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
