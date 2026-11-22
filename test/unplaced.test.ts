// Numbered notes without a place: they stand in the timeline by their time alone.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Day, Note, TripView } from "../src/shared/api";
import fixture from "./fixtures/hike.json";
import { type FakeImmich, fakeImmich, seedTrip, type TestApp, testApp } from "./helpers";

let immich: FakeImmich;
let app: TestApp;
let s: Awaited<ReturnType<typeof seedTrip>>;
const pt = (day: number, i: number) => (fixture.days as Day[])[day - 1]?.track[i] as Day["track"][number];

beforeAll(async () => {
  immich = fakeImmich();
  app = testApp(immich.url);
  s = await seedTrip(app);
});

const edit = (path: string, init: Parameters<TestApp["call"]>[1] = {}) =>
  app.call(`/api/t/${s.view}${path}`, { editor: true, ...init });
const create = async (json: unknown) => (await (await edit("/notes", { method: "POST", json })).json()) as Note;
const patch = (key: string, json: unknown) => edit(`/notes/${key}`, { method: "PATCH", json });
const keys = async () => ((await (await app.call(`/api/t/${s.view}`)).json()) as TripView).notes.map((n) => n.key);

describe("notes without a place", () => {
  test("one made at a time sits between the notes around that time, with no position", async () => {
    const early = await create({ lat: pt(2, 50)[0], lon: pt(2, 50)[1] });
    const late = await create({ lat: pt(2, 300)[0], lon: pt(2, 300)[1] });
    const between = new Date(Date.parse(pt(2, 150)[3]) + 7_000).toISOString();
    const r = await edit("/notes", { method: "POST", json: { lat: null, lon: null, at: between, title: "Gedanke" } });
    expect(r.status).toBe(201);
    const n = (await r.json()) as Note;
    expect([n.lat, n.lon]).toEqual([null, null]);
    expect(n.anchor).toMatchObject({ rule: "at", day: 2, dist_m: null, km: null, off_track: false });
    expect(Date.parse(n.anchor.t)).toBe(Date.parse(between));
    const order = await keys();
    expect(order.indexOf(early.key)).toBeLessThan(order.indexOf(n.key));
    expect(order.indexOf(n.key)).toBeLessThan(order.indexOf(late.key));
  });

  test("without a time it stands at its creation, which becomes its time", async () => {
    // Editors may date a note up to a week back (a placement queued offline).
    const created = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * 86_400_000).toISOString();
    const n = await create({ lat: null, lon: null, created });
    expect(n.at).toBe(created);
    expect(n.anchor.rule).toBe("at");
    expect(Date.parse(n.anchor.t)).toBe(Date.parse(created));
  });

  test("a placed note loses its place and keeps its spot in the timeline", async () => {
    const n = await create({ lat: pt(3, 150)[0], lon: pt(3, 150)[1] });
    const before = await keys();
    const r = await patch(n.key, { lat: null, lon: null });
    expect(r.status).toBe(200);
    const out = (await r.json()) as Note;
    expect([out.lat, out.lon]).toEqual([null, null]);
    expect(out.at).toBe(n.anchor.t);
    expect(out.anchor.rule).toBe("at");
    expect(await keys()).toEqual(before);
  });

  test("it regains a place and keeps its time until the time is cleared", async () => {
    const n = await create({ lat: null, lon: null, at: "2026-10-16T08:00:00+02:00" });
    const placed = (await (await patch(n.key, { lat: pt(4, 200)[0], lon: pt(4, 200)[1] })).json()) as Note;
    expect(placed.lat).toBe(pt(4, 200)[0]);
    expect(placed.anchor.rule).toBe("at");
    const back = (await (await patch(n.key, { at: null })).json()) as Note;
    expect(back.anchor.rule).toBe("track");
    expect(back.anchor.day).toBe(4);
  });

  test("its time can change, but not go away", async () => {
    const n = await create({ lat: null, lon: null, at: "2026-10-16T08:00:00+02:00" });
    const moved = (await (await patch(n.key, { at: "2026-10-18T19:00:00+02:00" })).json()) as Note;
    expect(moved.anchor.day).toBe(4);
    expect((await patch(n.key, { at: null })).status).toBe(400);
    expect((await patch(n.key, { lat: null, lon: null, at: null })).status).toBe(400);
  });

  test("validation", async () => {
    expect((await edit("/notes", { method: "POST", json: {} })).status).toBe(400);
    expect((await edit("/notes", { method: "POST", json: { lat: null } })).status).toBe(400);
    expect((await edit("/notes", { method: "POST", json: { lat: null, lon: 7.4 } })).status).toBe(400);
    expect((await patch("1", { lat: null })).status).toBe(400);
    expect((await patch("d2", { lat: null, lon: null })).status).toBe(400);
  });

  test("a retry with the same client_id finds the note it made", async () => {
    const body = { lat: null, lon: null, client_id: "7a1f0c00-1111-4222-8333-444455556666" };
    const a = await edit("/notes", { method: "POST", json: body });
    const b = await edit("/notes", { method: "POST", json: body });
    expect([a.status, b.status]).toEqual([201, 200]);
  });
});
