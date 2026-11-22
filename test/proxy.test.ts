// The Immich proxy serves only media attached to the token's trip, passes byte ranges through and
// never hands out the key.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Media, Note } from "../src/shared/api";
import { type FakeImmich, fakeImmich, IMMICH_KEY, seedTrip, type TestApp, testApp, VIDEO_BYTES } from "./helpers";

const PHOTO = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

let immich: FakeImmich;
let app: TestApp;
let a: Awaited<ReturnType<typeof seedTrip>>;
let b: Awaited<ReturnType<typeof seedTrip>>;
let photo: Media;
let video: Media;
let foreign: Media;

beforeAll(async () => {
  immich = fakeImmich();
  immich.assets.set(PHOTO, {
    id: PHOTO,
    type: "IMAGE",
    width: 3024,
    height: 4032,
    taken_at: "2026-10-16T09:30:00.000Z",
    lat: 49.82,
    lon: 7.41,
  });
  immich.assets.set(VIDEO, {
    id: VIDEO,
    type: "VIDEO",
    width: 1280,
    height: 720,
    taken_at: "2026-10-16T10:00:00.000Z",
    duration_ms: 14_000,
  });
  immich.assets.set(OTHER, {
    id: OTHER,
    type: "IMAGE",
    width: 4000,
    height: 3000,
    taken_at: "2026-10-17T10:00:00.000Z",
  });
  app = testApp(immich.url);
  a = await seedTrip(app, "trip-a");
  b = await seedTrip(app, "trip-b");
  const note = async (s: typeof a) =>
    (await (
      await app.call(`/api/t/${s.view}/notes`, { method: "POST", editor: true, json: { lat: 49.82, lon: 7.41 } })
    ).json()) as Note;
  // Immich assets are attached through the admin API; the URLs come from the editor's view.
  const attach = async (s: typeof a, n: Note, id: string) => {
    const slug = s === a ? "trip-a" : "trip-b";
    const r = await app.call(`/api/admin/trips/${slug}/notes/${n.key}/media`, {
      method: "POST",
      admin: true,
      json: { immich_id: id },
    });
    const m = (await r.json()) as Media;
    const fresh = (await (await app.call(`/api/t/${s.view}/notes/${n.key}`, { editor: true })).json()) as Note;
    return fresh.media.find((x) => x.id === m.id) as Media;
  };
  const na = await note(a);
  photo = await attach(a, na, PHOTO);
  video = await attach(a, na, VIDEO);
  foreign = await attach(b, await note(b), OTHER);
});
afterAll(() => immich.stop());
beforeEach(() => {
  immich.requests.length = 0;
  immich.failWith = null;
});

const get = (path: string, headers: Record<string, string> = {}) => app.call(path, { headers });

describe("allowlist", () => {
  test("attached media are served through the token's trip", async () => {
    const res = await get(photo.preview.replace("/api/t/", `/api/t/`));
    expect(photo.preview.startsWith(`/api/t/${a.view}/m/${photo.id}/preview?v=`)).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(immich.requests.at(-1)?.path).toBe(`/api/assets/${PHOTO}/thumbnail?size=preview&edited=true`);
  });

  test("another trip's media id is not found through this token", async () => {
    expect((await get(`/api/t/${a.view}/m/${foreign.id}/preview`)).status).toBe(404);
    expect((await get(`/api/t/${b.view}/m/${photo.id}/thumb`)).status).toBe(404);
    expect(immich.requests.length).toBe(0);
  });

  test("an Immich asset id in place of a media id is refused without asking Immich", async () => {
    for (const path of [
      `/api/t/${a.view}/m/${PHOTO}/preview`,
      `/api/t/${a.view}/m/${OTHER}/thumb`,
      `/api/t/${a.view}/m/..%2F..%2Fassets%2F${OTHER}/thumb`,
      `/api/t/${a.view}/m/${photo.id}/original`,
      `/api/t/${a.view}/m/${photo.id}/thumbnail`,
      `/api/t/${a.view}/m/${photo.id}/video`,
      `/api/t/${a.view}/m/99999/thumb`,
    ])
      expect((await get(path)).status).toBe(404);
    expect(immich.requests.length).toBe(0);
  });

  test("a bad view token reaches no media", async () => {
    expect((await get(`/api/t/AAAAAAAAAAAAAAAAAAAAAA/m/${photo.id}/thumb`)).status).toBe(404);
    expect(immich.requests.length).toBe(0);
  });
});

describe("passthrough", () => {
  test("Range requests reach Immich and the partial response comes back", async () => {
    const res = await get(video.video as string, { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${VIDEO_BYTES}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100 % 251);
    expect(immich.requests.at(-1)).toMatchObject({
      path: `/api/assets/${VIDEO}/video/playback`,
      range: "bytes=100-199",
    });
  });

  test("a full video request streams the whole body", async () => {
    const res = await get(video.video as string);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(VIDEO_BYTES);
    expect(immich.requests.at(-1)?.range).toBeNull();
  });

  test("an unsatisfiable range is answered as Immich answered it", async () => {
    const res = await get(video.video as string, { range: `bytes=${VIDEO_BYTES + 5}-` });
    expect(res.status).toBe(416);
  });

  test("the key goes to Immich and never back to the client", async () => {
    const res = await get(photo.thumb);
    expect(immich.requests.at(-1)?.key).toBe(IMMICH_KEY);
    const all = [...res.headers.entries()].flat().join(" ") + (await res.text());
    expect(all).not.toContain(IMMICH_KEY);
    const view = await (await app.call(`/api/t/${a.view}`, { editor: true })).text();
    expect(view).not.toContain(IMMICH_KEY);
  });

  test("versioned URLs are cacheable forever, others briefly", async () => {
    expect((await get(photo.thumb)).headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await get(`/api/t/${a.view}/m/${photo.id}/thumb`)).headers.get("cache-control")).toBe(
      "private, max-age=300",
    );
  });

  test("Immich failing gives a placeholder picture, or 502 for a video", async () => {
    immich.failWith = 500;
    const img = await get(photo.preview);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/svg+xml");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect((await get(video.video as string)).status).toBe(502);
  });
});

describe("metadata at attach", () => {
  test("preview dimensions and the video duration come from Immich", () => {
    expect([photo.width, photo.height]).toEqual([1080, 1440]);
    expect(photo.type).toBe("image");
    expect(video.type).toBe("video");
    expect(video.duration_ms).toBe(14_000);
    expect(video.video).toContain(`/m/${video.id}/video?v=`);
    expect(photo.video).toBeNull();
  });
});

describe("media responses", () => {
  test("carry a sandboxing CSP", async () => {
    const res = await get(photo.thumb);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  test("a proxied body that never ends is cut at the body deadline", async () => {
    const slow = testApp(immich.url, null, undefined, { bodyTimeoutMs: 300 });
    const t = await seedTrip(slow);
    const n = (await (
      await slow.call(`/api/t/${t.view}/notes`, { method: "POST", editor: true, json: { lat: 49.85, lon: 7.42 } })
    ).json()) as Note;
    const id = "99999999-9999-4999-8999-999999999999";
    immich.assets.set(id, {
      id,
      type: "VIDEO",
      width: 1280,
      height: 720,
      taken_at: "2026-10-16T09:00:00.000Z",
      endless: true,
    });
    const m = (await (
      await slow.call(`/api/admin/trips/sample/notes/${n.key}/media`, {
        method: "POST",
        admin: true,
        json: { immich_id: id },
      })
    ).json()) as Media;
    const res = await slow.call(m.video as string, { admin: true });
    const t0 = Date.now();
    const done = await res.arrayBuffer().then(
      () => "ended",
      () => "aborted",
    );
    expect(["ended", "aborted"]).toContain(done);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("Immich access", () => {
  test("the app only reads: GETs, and the metadata search", async () => {
    const n = (await (
      await app.call(`/api/t/${a.view}/notes`, { method: "POST", editor: true, json: { lat: 49.85, lon: 7.42 } })
    ).json()) as Note;
    immich.requests.length = 0;
    await app.call(`/api/t/${a.view}/notes/${n.key}/media`, {
      method: "POST",
      editor: true,
      json: { immich_id: OTHER },
    });
    await get(photo.thumb);
    await get(video.video as string, { range: "bytes=0-9" });
    expect(immich.requests.length).toBeGreaterThan(2);
    expect(immich.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});
