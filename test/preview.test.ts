import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb, Store } from "../src/server/db";
import { project, SECTION } from "../src/server/preview";
import type { Entry, MapCreated, MapShare } from "../src/shared/api";
import { fakeImmich, testApp } from "./helpers";

const immich = fakeImmich();
afterAll(() => immich.stop());

const STATIC = join(import.meta.dir, "../web/static");
const HTML = "<head><!--OG--><title><!--TITLE--></title></head><script><!--MAP--></script>";
const west = { lat: 50.94, lon: 6.96 };
const northeast = { lat: 53.55, lon: 9.99 };
const rome = { lat: 41.9, lon: 12.5 };

/** A web directory with the committed pictures under `assets`. */
function webDir(files = ["map-base.jpg", "map-fallback.jpg"]): string {
  const dir = mkdtempSync(join(tmpdir(), "trip-preview-"));
  mkdirSync(join(dir, "assets"));
  for (const f of files) cpSync(join(STATIC, f), join(dir, "assets", f));
  return dir;
}

async function setup(files?: string[]) {
  const app = testApp(immich.url, null, webDir(files), { mapHtml: HTML });
  const res = await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "Leute" } });
  const made = (await res.json()) as MapCreated;
  const edit = `/api/m/${made.edit.token}`;
  const add = async (name: string, at: { lat: number; lon: number }[]) =>
    (await (
      await app.call(`${edit}/entries`, {
        method: "POST",
        json: { name, places: at.map((p) => ({ label: "", address: "", ...p })) },
      })
    ).json()) as Entry;
  /** The path and query of the page's og:image, from either link. */
  const image = async (token: string) => {
    const html = await (await app.call(`/m/${token}`)).text();
    const m = /property="og:image" content="https:\/\/trip\.example\.org([^"]+)"/.exec(html);
    return m?.[1] as string;
  };
  return { app, made, edit, add, image };
}

const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("the preview picture", () => {
  test("the tag names an id that is neither token, the same from either link", async () => {
    const { made, add, image } = await setup();
    await add("A", [west]);
    const read = await image(made.view.token);
    const write = await image(made.edit.token);
    expect(read).toBe(write);
    expect(read).toMatch(/^\/preview\/[0-9a-f]{32}\.jpg\?v=\d+$/);
    for (const token of [made.view.token, made.edit.token]) expect(read).not.toContain(token);
  });

  test("answers 200 with a square JPEG for the id and 404 for anything else", async () => {
    const { app, made, add, image } = await setup();
    await add("A", [west]);
    await add("B", [northeast]);
    const path = await image(made.edit.token);
    const res = await app.call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await bytes(res);
    expect(body.length).toBeLessThan(300_000);
    const meta = await new Bun.Image(body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", SECTION.size, SECTION.size]);
    expect((await app.call(`/preview/${"0".repeat(32)}.jpg`)).status).toBe(404);
    expect((await app.call(`/preview/${made.view.token}.jpg`)).status).toBe(404);
    expect((await app.call(`/preview/${made.edit.token}.jpg`)).status).toBe(404);
    expect((await app.call("/preview/short.jpg")).status).toBe(404);
  });

  test("a change of the map changes the picture and its URL, a repeat does not", async () => {
    const { app, made, add, image } = await setup();
    await add("A", [west]);
    const first = await image(made.view.token);
    const a = await bytes(await app.call(first));
    // A change that leaves the revision alone is not seen: the composed bytes are kept per revision.
    app.store.db.exec("UPDATE entry SET color = 5");
    expect(await bytes(await app.call(first))).toEqual(a);
    await add("B", [northeast]);
    const second = await image(made.view.token);
    expect(second).not.toBe(first);
    expect(await bytes(await app.call(second))).not.toEqual(a);
  });

  test("an entry's picture and colour show", async () => {
    const { app, made, edit, add, image } = await setup();
    const e = await add("A", [west]);
    const plain = await bytes(await app.call(await image(made.view.token)));
    const face = await new Bun.Image(await Bun.file(join(STATIC, "map-base.jpg")).bytes())
      .resize(64, 64)
      .jpeg()
      .bytes();
    const put = await app.call(`${edit}/entries/${e.id}/avatar`, {
      method: "PUT",
      body: face as Uint8Array<ArrayBuffer>,
      headers: { "content-type": "image/jpeg" },
    });
    expect(put.status).toBe(200);
    expect(await bytes(await app.call(await image(made.view.token)))).not.toEqual(plain);
    await app.call(`${edit}/entries/${e.id}`, { method: "PATCH", json: { color: 3 } });
    expect(await bytes(await app.call(await image(made.view.token)))).not.toEqual(plain);
  });

  test("a place outside the section is left out; a map with none inside gets the generic picture", async () => {
    const { app, made, add, image } = await setup();
    expect(await image(made.view.token)).toBe("/assets/map-fallback.jpg");
    await add("Rom", [rome]);
    expect(await image(made.view.token)).toBe("/assets/map-fallback.jpg");
    await add("A", [west, rome]);
    expect(await image(made.view.token)).toMatch(/^\/preview\//);
    expect((await app.call("/assets/map-fallback.jpg")).status).toBe(200);
  });

  test("deleted entries leave the picture", async () => {
    const { app, made, edit, add, image } = await setup();
    await add("A", [west]);
    const b = await add("B", [northeast]);
    const both = await bytes(await app.call(await image(made.view.token)));
    await app.call(`${edit}/entries/${b.id}`, { method: "DELETE" });
    expect(await bytes(await app.call(await image(made.view.token)))).not.toEqual(both);
  });

  test("revoking a share replaces the id", async () => {
    const { app, made, add, image } = await setup();
    await add("A", [west]);
    const before = await image(made.view.token);
    const shares = (await (await app.call("/api/admin/maps/m/shares", { admin: true })).json()) as MapShare[];
    await app.call(`/api/admin/maps/m/shares/${shares[1]?.id}`, { method: "DELETE", admin: true });
    expect((await app.call(before)).status).toBe(404);
    const after = await image(made.view.token);
    expect(after).not.toBe(before);
    expect((await app.call(after)).status).toBe(200);
  });

  test("a failing composition answers with the generic picture", async () => {
    const { app, made, add, image } = await setup(["map-fallback.jpg"]);
    await add("A", [west]);
    const res = await app.call(await image(made.view.token));
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(new Uint8Array(await Bun.file(join(STATIC, "map-fallback.jpg")).arrayBuffer()));
  });

  test("a burst composes once", async () => {
    const { app, made, add, image } = await setup();
    await add("A", [west]);
    const path = await image(made.view.token);
    const all = await Promise.all(Array.from({ length: 20 }, async () => bytes(await app.call(path))));
    for (const b of all) expect(b).toEqual(all[0] as Uint8Array<ArrayBuffer>);
  });
});

describe("the section", () => {
  test("holds the places it has to and leaves out the rest", () => {
    for (const p of [west, northeast, { lat: 50.11, lon: 8.68 }, { lat: 48.14, lon: 11.58 }, { lat: 52.52, lon: 13.4 }])
      expect(project(p.lat, p.lon)).not.toBeNull();
    expect(project(rome.lat, rome.lon)).toBeNull();
    expect(project(52, 40)).toBeNull();
  });

  test("a coordinate lands on its pixel", () => {
    const [x, y] = project(SECTION.lat, SECTION.lon) as [number, number];
    expect([x, y]).toEqual([SECTION.size / 2, SECTION.size / 2]);
  });
});

describe("upgrading a database without preview ids", () => {
  test("every existing map gains a distinct one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "trip-upgrade-")), "trip.db");
    const old = new Database(path, { create: true });
    const preview = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN preview_id"));
    for (const [i, m] of MIGRATIONS.slice(0, preview).entries()) {
      old.exec(m);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    old.exec(`INSERT INTO map (slug, title, created) VALUES ('a', 'A', 'x'), ('b', 'B', 'x')`);
    old.close();
    const ids = new Store(openDb(path)).maps().map((m) => m.preview_id);
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});
