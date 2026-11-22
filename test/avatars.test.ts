import { afterAll, describe, expect, test } from "bun:test";
import { sniff } from "../src/server/avatars";
import type { Entry, EntryWritten, MapCreated, MapView } from "../src/shared/api";
import { fakeImmich, testApp } from "./helpers";

const immich = fakeImmich();
afterAll(() => immich.stop());

/** The bytes a type check and a size check look at. */
function png(w: number, h: number, extra = 0): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[32] = extra % 251;
  return b;
}

function jpeg(w: number, h: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
  new DataView(b.buffer).setUint16(13, h);
  new DataView(b.buffer).setUint16(15, w);
  return b;
}

function webp(w: number, h: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(40);
  const text = (at: number, s: string) =>
    b.set(
      [...s].map((c) => c.charCodeAt(0)),
      at,
    );
  text(0, "RIFF");
  text(8, "WEBP");
  text(12, "VP8X");
  b.set([(w - 1) & 255, (w - 1) >> 8, 0, (h - 1) & 255, (h - 1) >> 8, 0], 24);
  return b;
}

async function setup(over: Parameters<typeof testApp>[3] = {}) {
  const app = testApp(immich.url, null, undefined, over);
  const made = (await (
    await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "M" } })
  ).json()) as MapCreated;
  const base = `/api/m/${made.edit.token}`;
  const e = (await (await app.call(`${base}/entries`, { method: "POST", json: { name: "A" } })).json()) as Entry;
  const put = (body: Uint8Array<ArrayBuffer>, id = e.id) =>
    app.call(`${base}/entries/${id}/avatar`, { method: "PUT", body, headers: { "content-type": "image/png" } });
  return { app, made, base, e, put };
}

describe("sniff", () => {
  test("reads type and size from the bytes", () => {
    expect(sniff(png(100, 200))).toEqual({ type: "image/png", size: [100, 200] });
    expect(sniff(jpeg(300, 256))).toEqual({ type: "image/jpeg", size: [300, 256] });
    expect(sniff(webp(64, 32))).toEqual({ type: "image/webp", size: [64, 32] });
    expect(sniff(new TextEncoder().encode("GIF89a........................................"))).toBeNull();
  });
});

describe("an avatar", () => {
  test("is stored, shown in the view and served as a picture only", async () => {
    const { app, base, made, put } = await setup();
    const res = await put(png(256, 256));
    expect(res.status).toBe(200);
    const e = (await res.json()) as EntryWritten;
    expect(e.avatar).toMatch(/^[0-9a-f]{32}$/);
    const v = (await (await app.call(`/api/m/${made.view.token}`)).json()) as MapView;
    expect(v.entries[0]?.avatar).toBe(e.avatar);
    const got = await app.call(`/api/m/${made.view.token}/avatar/${e.avatar}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png(256, 256));
    expect((await app.call(`${base}/avatar/${"0".repeat(32)}`)).status).toBe(404);
  });

  test("is refused when not a picture, too large in bytes or in pixels", async () => {
    const { put } = await setup();
    expect((await put(new TextEncoder().encode("GIF89a".padEnd(50, ".")) as Uint8Array<ArrayBuffer>)).status).toBe(415);
    expect((await put(png(256, 256, 131072))).status).toBe(413);
    expect((await put(png(600, 600))).status).toBe(400);
    expect((await put(jpeg(513, 10))).status).toBe(400);
    expect((await put(webp(600, 10))).status).toBe(400);
  });

  test("an announced size over the limit is refused by its header alone", async () => {
    const { app, base, e } = await setup();
    const res = await app.call(`${base}/entries/${e.id}/avatar`, {
      method: "PUT",
      body: png(10, 10),
      headers: { "content-length": "131073" },
    });
    expect(res.status).toBe(413);
  });

  test("a read link may not upload; another map does not have it", async () => {
    const { app, made, e, put } = await setup();
    const id = ((await (await put(png(10, 10))).json()) as EntryWritten).avatar;
    const res = await app.call(`/api/m/${made.view.token}/entries/${e.id}/avatar`, {
      method: "PUT",
      body: png(11, 11),
    });
    expect(res.status).toBe(403);
    const other = (await (
      await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "o", title: "O" } })
    ).json()) as MapCreated;
    expect((await app.call(`/api/m/${other.view.token}/avatar/${id}`)).status).toBe(404);
  });

  test("the same bytes are one row", async () => {
    const { app, put } = await setup();
    await put(png(10, 10));
    await put(png(10, 10));
    expect((app.store.db.query("SELECT COUNT(*) AS n FROM avatar").get() as { n: number }).n).toBe(1);
  });

  test("undo brings the earlier picture back; DELETE and an emoji patch clear it", async () => {
    const { app, base, e, put } = await setup();
    const first = ((await (await put(png(10, 10))).json()) as EntryWritten).avatar;
    const second = (await (await put(png(20, 20))).json()) as EntryWritten;
    expect(second.avatar).not.toBe(first);
    const back = await app.call(`${base}/entries/${e.id}/restore`, { method: "POST", json: { rev: second.undo_rev } });
    expect(((await back.json()) as Entry).avatar).toBe(first);
    const gone = await app.call(`${base}/entries/${e.id}/avatar`, { method: "DELETE" });
    expect(((await gone.json()) as Entry).avatar).toBeNull();
    await put(png(10, 10));
    const patched = await app.call(`${base}/entries/${e.id}`, { method: "PATCH", json: { emoji: "🦊", avatar: null } });
    const p = (await patched.json()) as Entry;
    expect([p.avatar, p.emoji]).toEqual([null, "🦊"]);
    expect((await app.call(`${base}/entries/${e.id}`, { method: "PATCH", json: { avatar: "x" } })).status).toBe(400);
  });

  test("the purge keeps what any history names and drops the rest", async () => {
    const { app, base, e, put } = await setup({ maps: { history_keep: 2 } });
    const id = async (n: number) => ((await (await put(png(n, n))).json()) as EntryWritten).avatar as string;
    const [first, second, third, current] = [await id(10), await id(20), await id(30), await id(40)];
    expect(app.store.purgeAvatars()).toBe(1);
    expect(app.store.avatar(1, first)).toBeNull();
    for (const kept of [second, third, current]) expect(app.store.avatar(1, kept)).not.toBeNull();
    await app.call(`${base}/entries/${e.id}`, { method: "PATCH", json: { note: "x" } });
    await app.call(`${base}/entries/${e.id}`, { method: "PATCH", json: { note: "y" } });
    expect(app.store.purgeAvatars()).toBe(2);
    expect(app.store.avatar(1, current)).not.toBeNull();
  });

  test("uploads have a budget per token; the admin has none", async () => {
    const { app, e, put } = await setup({ maps: { avatar_per_minute: 1 } });
    expect((await put(png(10, 10))).status).toBe(200);
    expect((await put(png(11, 11))).status).toBe(429);
    const res = await app.call(`/api/admin/maps/m/entries/${e.id}/avatar`, {
      method: "PUT",
      admin: true,
      body: png(12, 12),
    });
    expect(res.status).toBe(200);
  });
});
