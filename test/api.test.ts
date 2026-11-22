// Notes, media and admin routes end to end against a temporary database and a fake Immich.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Day, Media, Note, Suggestion, TripAdminView, TripView } from "../src/shared/api";
import fixture from "./fixtures/hike.json";
import { type FakeImmich, fakeImmich, onTrack, seedTrip, type TestApp, testApp } from "./helpers";

const GPS = "44444444-4444-4444-8444-444444444444";
const NOGPS = "55555555-5555-4555-8555-555555555555";

let immich: FakeImmich;
let app: TestApp;
let s: Awaited<ReturnType<typeof seedTrip>>;

beforeAll(async () => {
  immich = fakeImmich();
  immich.assets.set(GPS, {
    id: GPS,
    type: "IMAGE",
    width: 4000,
    height: 3000,
    taken_at: "2026-10-17T09:10:00.000Z",
    lat: 49.85,
    lon: 7.42,
  });
  immich.assets.set(NOGPS, {
    id: NOGPS,
    type: "IMAGE",
    width: 3000,
    height: 4000,
    taken_at: "2026-10-18T10:00:00.000Z",
  });
  app = testApp(
    immich.url,
    "<html><title><!--TITLE--></title><script id=trip type=application/json><!--TRIP--></script></html>",
  );
  s = await seedTrip(app);
});
afterAll(() => immich.stop());

const edit = (path: string, init: Parameters<TestApp["call"]>[1] = {}) =>
  app.call(`/api/t/${s.view}${path}`, { editor: true, ...init });
const admin = (path: string, init: Parameters<TestApp["call"]>[1] = {}) =>
  app.call(`/api/admin/trips/sample${path}`, { admin: true, ...init });
const view = async () => (await (await app.call(`/api/t/${s.view}`)).json()) as TripView;

describe("notes", () => {
  test("numbers count up, and the timeline orders by track time, not by number", async () => {
    const day4 = (await (await edit("/notes", { method: "POST", json: onTrack(4, 0.5) })).json()) as Note;
    const day2 = (await (
      await edit("/notes", { method: "POST", json: { ...onTrack(2, 0.4), title: "Bach" } })
    ).json()) as Note;
    expect([day4.number, day2.number]).toEqual([1, 2]);
    expect(day4.anchor.day).toBe(4);
    expect(day2.anchor.day).toBe(2);
    const keys = (await view()).notes.map((n) => n.key);
    expect(keys.indexOf("2")).toBeLessThan(keys.indexOf("d2"));
    expect(keys.indexOf("d3")).toBeLessThan(keys.indexOf("1"));
    expect(keys.slice(0, 2)).toEqual(["d1", "2"]);
  });

  test("every day has its day-end note", async () => {
    const v = await view();
    expect(v.notes.filter((n) => n.kind === "day").map((n) => n.key)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    const d1 = v.notes.find((n) => n.key === "d1") as Note;
    const camp = fixture.days[0]?.end as { lat: number; lon: number };
    expect([d1.lat, d1.lon]).toEqual([camp.lat, camp.lon]);
    expect(d1.anchor.rule).toBe("day-end");
  });

  test("a stale If-Match is refused with the current note", async () => {
    const n = (await (await edit("/notes/2", { method: "PATCH", json: { text: "first" } })).json()) as Note;
    const stale = await edit("/notes/2", {
      method: "PATCH",
      json: { text: "second" },
      headers: { "if-match": String(n.rev - 1) },
    });
    expect(stale.status).toBe(412);
    const body = (await stale.json()) as { note: Note };
    expect(body.note.text).toBe("first");
    const ok = await edit("/notes/2", {
      method: "PATCH",
      json: { text: "second" },
      headers: { "if-match": String(n.rev) },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Note).text).toBe("second");
  });

  test("deleting leaves a gap; the next note does not reuse a lower number", async () => {
    const third = (await (await edit("/notes", { method: "POST", json: { lat: 49.86, lon: 7.45 } })).json()) as Note;
    expect(third.number).toBe(3);
    expect((await edit("/notes/2", { method: "DELETE" })).status).toBe(204);
    const fourth = (await (await edit("/notes", { method: "POST", json: { lat: 49.86, lon: 7.46 } })).json()) as Note;
    expect(fourth.number).toBe(4);
    expect((await view()).notes.some((n) => n.key === "2")).toBe(false);
  });

  test("editors cannot set admin-only fields; admin can, numbers stay unique", async () => {
    expect((await edit("/notes", { method: "POST", json: { lat: 49.8, lon: 7.4, number: 50 } })).status).toBe(400);
    const r = await app.call("/api/admin/trips/sample/notes", {
      method: "POST",
      admin: true,
      json: { ...onTrack(1, 0.01), number: 20, created: "2026-10-20T11:28:47.345Z", extra: { legacy: true } },
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as Note).extra).toEqual({ legacy: true });
    const again = await app.call("/api/admin/trips/sample/notes", {
      method: "POST",
      admin: true,
      json: { lat: 49.8, lon: 7.4, number: 20 },
    });
    expect(again.status).toBe(409);
  });

  test("one note can be read on its own, by editors and admin", async () => {
    const r = await edit("/notes/d3");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Note).key).toBe("d3");
    expect((await app.call("/api/admin/trips/sample/notes/1", { admin: true })).status).toBe(200);
    expect((await app.call(`/api/t/${s.view}/notes/1`)).status).toBe(403);
  });

  test("a placement sent twice with the same client_id makes one note", async () => {
    const body = { lat: 49.86, lon: 7.47, client_id: "5f0c1a0e-1111-4222-8333-444455556666" };
    const a = await edit("/notes", { method: "POST", json: body });
    const b = await edit("/notes", { method: "POST", json: body });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(((await b.json()) as Note).key).toBe(((await a.json()) as Note).key);
  });

  test("validation", async () => {
    expect((await edit("/notes", { method: "POST", json: { lat: 95, lon: 7 } })).status).toBe(400);
    expect((await edit("/notes", { method: "POST", json: { lat: 49, lon: 7, at: "yesterday" } })).status).toBe(400);
    expect((await edit("/notes/d1", { method: "PATCH", json: { lat: 49, lon: 7 } })).status).toBe(400);
    expect((await edit("/notes/d1", { method: "DELETE" })).status).toBe(409);
    expect((await edit("/notes/x1", { method: "PATCH", json: { text: "" } })).status).toBe(404);
    expect(
      (await edit("/notes", { method: "POST", body: "{", headers: { "content-type": "application/json" } })).status,
    ).toBe(400);
  });

  test("a day-end note takes text but not a position", async () => {
    const r = await edit("/notes/d3", { method: "PATCH", json: { title: "Abend am Feuer", text: "Ruhig." } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Note).title).toBe("Abend am Feuer");
    const del = await app.call("/api/admin/trips/sample/days/3", { method: "DELETE", admin: true });
    expect(del.status).toBe(409);
  });
});

describe("limits", () => {
  test("a trip's numbered notes stop at the note limit", async () => {
    const q = testApp(immich.url, null, undefined, { limits: { max_notes: 2 } });
    const t = await seedTrip(q);
    const place = () =>
      q.call(`/api/t/${t.view}/notes`, { method: "POST", editor: true, json: { lat: 49.85, lon: 7.42 } });
    expect((await place()).status).toBe(201);
    expect((await place()).status).toBe(201);
    expect((await place()).status).toBe(409);
  });
});

describe("media", () => {
  test("from_asset places the note at the photo's GPS and attaches it", async () => {
    const n = (await (await admin("/notes", { method: "POST", json: { from_asset: GPS } })).json()) as Note;
    expect([n.lat, n.lon]).toEqual([49.85, 7.42]);
    expect(n.media.map((m) => m.immich_id)).toEqual([GPS]);
  });

  test("from_asset without GPS uses the track position at the capture time", async () => {
    const n = (await (await admin("/notes", { method: "POST", json: { from_asset: NOGPS } })).json()) as Note;
    expect(n.anchor.day).toBe(4);
    expect(Math.abs(Date.parse(n.anchor.t) - Date.parse("2026-10-18T10:00:00.000Z"))).toBeLessThan(5 * 60_000);
  });

  test("the editor session attaches an Immich asset; a second attach and a missing asset are refused", async () => {
    const r = await edit("/notes/1/media", { method: "POST", json: { immich_id: GPS, caption: "Blick" } });
    expect(r.status).toBe(201);
    const m = (await r.json()) as Media;
    expect([m.immich_id, m.caption, m.type]).toEqual([GPS, "Blick", "image"]);
    expect((await edit("/notes/1/media", { method: "POST", json: { immich_id: GPS } })).status).toBe(409);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await edit("/notes/1/media", { method: "POST", json: { immich_id: missing } })).status).toBe(404);
    expect((await edit("/notes/1/media", { method: "POST", json: { immich_id: "not-an-id" } })).status).toBe(400);
    expect((await edit(`/notes/1/media/${m.id}`, { method: "DELETE" })).status).toBe(204);
  });

  test("a file upload is no longer accepted", async () => {
    const form = new FormData();
    form.set("file", new Blob(["x"]), "x.png");
    expect((await edit("/notes/1/media", { method: "POST", body: form })).status).toBe(400);
  });

  test("captions and order", async () => {
    await admin("/notes/1/media", { method: "POST", json: { immich_id: GPS } });
    const second = (await (
      await admin("/notes/1/media", { method: "POST", json: { immich_id: NOGPS, position: 0 } })
    ).json()) as Media;
    let n = (await view()).notes.find((x) => x.key === "1") as Note;
    expect(n.media.map((m) => m.id)[0]).toBe(second.id);
    await edit(`/notes/1/media/${second.id}`, { method: "PATCH", json: { position: 5, caption: "Wald" } });
    n = (await view()).notes.find((x) => x.key === "1") as Note;
    expect(n.media.at(-1)?.id).toBe(second.id);
    expect(n.media.at(-1)?.caption).toBe("Wald");
    expect(n.media.map((m) => m.position)).toEqual(n.media.map((_, i) => i));
    expect((await admin("/notes/1/media", { method: "POST", json: { immich_id: GPS } })).status).toBe(409);
    // Friends never see Immich ids.
    expect(JSON.stringify(await view())).not.toContain(GPS);
  });

  test("an editor session cannot make a note from an asset", async () => {
    expect((await edit("/notes", { method: "POST", json: { from_asset: GPS } })).status).toBe(400);
  });

  test("an unknown Immich asset is a 404", async () => {
    const r = await admin("/notes/1/media", {
      method: "POST",
      json: { immich_id: "66666666-6666-4666-8666-666666666666" },
    });
    expect(r.status).toBe(404);
  });
});

describe("admin and views", () => {
  test("suggestions cover the trip window with nearest note and track position", async () => {
    const r = await app.call("/api/admin/trips/sample/suggest", { admin: true });
    expect(r.status).toBe(200);
    const list = (await r.json()) as Suggestion[];
    expect(list.map((x) => x.immich_id)).toEqual([GPS, NOGPS]);
    expect(list[0]?.attached_to.length).toBeGreaterThan(0);
    expect(list[1]?.nearest_note).toBeNull();
    expect(list[1]?.track?.day).toBe(4);
  });

  test("suggestions never search outside the trip's window", async () => {
    immich.requests.length = 0;
    const r = await admin("/suggest?from=1970-01-01T00:00:00Z&to=2100-01-01T00:00:00Z");
    expect(r.status).toBe(200);
    const q = immich.requests.find((x) => x.path.startsWith("/api/search/metadata"));
    expect(q).toBeDefined();
    const { gte, lt } = (q as { body: { filter: { takenAt: { gte: string; lt: string } } } }).body.filter.takenAt;
    // The trip starts on 15 Oct (Berlin); its tracks end 19 Oct 16:52, unless a note stands later.
    // 12 h either side.
    const v = (await (await admin("")).json()) as TripAdminView;
    const last = Math.max(Date.parse("2026-10-19T16:51:54+02:00"), ...v.notes.map((n) => Date.parse(n.anchor.t)));
    expect(Date.parse(gte)).toBe(Date.parse("2026-10-15T00:00:00+02:00") - 12 * 3_600_000);
    expect(Date.parse(lt)).toBe(last + 12 * 3_600_000);
  });

  test("the admin view lists shares and uses admin media URLs", async () => {
    const v = (await (await app.call("/api/admin/trips/sample", { admin: true })).json()) as TripAdminView;
    expect(v.shares.map((x) => [x.role, x.editor])).toEqual([["view", false]]);
    const m = v.notes.flatMap((n) => n.media)[0] as Media;
    expect(m.thumb.startsWith("/api/admin/trips/sample/m/")).toBe(true);
    expect((await app.call(m.thumb, { admin: true })).status).toBe(200);
  });

  test("the view answers 304 until something changes", async () => {
    const first = await app.call(`/api/t/${s.view}`);
    const etag = first.headers.get("etag") as string;
    expect((await app.call(`/api/t/${s.view}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    await edit("/notes/1", { method: "PATCH", json: { title: "Neu" } });
    expect((await app.call(`/api/t/${s.view}`, { headers: { "if-none-match": etag } })).status).toBe(200);
  });

  test("the page inlines the trip, escaped, with a strict CSP", async () => {
    await edit("/notes/1", { method: "PATCH", json: { title: "</script><script>alert(1)</script>" } });
    const r = await app.call(`/${s.view}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain("</script><script>alert(1)");
    const json = /<script id=trip type=application\/json>(.*)<\/script>/s.exec(html)?.[1] as string;
    const v = JSON.parse(json) as TripView;
    expect(v.editable).toBe(false);
    expect(v.notes.find((n) => n.key === "1")?.title).toBe("</script><script>alert(1)</script>");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  test("a day end without camp_type is accepted as null", async () => {
    const r = await app.call("/api/admin/trips/sample/days/9", {
      method: "PUT",
      admin: true,
      json: { date: "2026-10-23", track: [], stats: null, end: { lat: 49.9, lon: 7.6, name: "Hütte" }, source: null },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { end: { camp_type: unknown } }).end.camp_type).toBeNull();
    expect((await app.call("/api/admin/trips/sample/days/9", { method: "DELETE", admin: true })).status).toBe(204);
  });

  test("a day's breaks are validated, stored and returned; without breaks the field is absent", async () => {
    const track = [0, 1, 2, 3].map((i) => [49.9, 7.5 + i * 0.01, 300, `2026-10-20T1${i}:00:00+02:00`]);
    const put = (breaks?: unknown) =>
      app.call("/api/admin/trips/sample/days/9", {
        method: "PUT",
        admin: true,
        json: {
          date: "2026-10-20",
          track,
          ...(breaks === undefined ? {} : { breaks }),
          stats: null,
          end: null,
          source: null,
        },
      });
    for (const bad of [[0], [4], [2, 2], [3, 1], [1.5], "2"]) expect((await put(bad)).status).toBe(400);
    const ok = await put([2]);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Day).breaks).toEqual([2]);
    const view = (await (await app.call("/api/admin/trips/sample", { admin: true })).json()) as { days: Day[] };
    expect(view.days.find((d) => d.n === 9)?.breaks).toEqual([2]);
    expect(((await (await put()).json()) as Day).breaks).toBeUndefined();
    await app.call("/api/admin/trips/sample/days/9", { method: "DELETE", admin: true });
  });

  test("trip list and patch", async () => {
    const list = (await (await app.call("/api/admin/trips", { admin: true })).json()) as {
      slug: string;
      days: number;
    }[];
    expect(list).toEqual([expect.objectContaining({ slug: "sample", days: 5 })]);
    const p = await app.call("/api/admin/trips/sample", {
      method: "PATCH",
      admin: true,
      json: { timezone: "Mars/Olympus" },
    });
    expect(p.status).toBe(400);
    const ok = await app.call("/api/admin/trips/sample", {
      method: "PATCH",
      admin: true,
      json: { short_title: "Soon" },
    });
    expect(((await ok.json()) as { short_title: string }).short_title).toBe("Soon");
  });
});
