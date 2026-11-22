import { afterAll, describe, expect, test } from "bun:test";
import { purgeEntries } from "../src/server/maps";
import type {
  Entry,
  EntryRev,
  EntryWritten,
  MapAdminView,
  MapCreated,
  MapShare,
  MapSummary,
  MapView,
} from "../src/shared/api";
import { fakeImmich, testApp } from "./helpers";

const immich = fakeImmich();
afterAll(() => immich.stop());

const HTML = "<title><!--TITLE--></title><script><!--MAP--></script>";
const place = { label: "Zuhause", address: "Musterweg 7, 30163 Hannover", lat: 52.36, lon: 9.75 };

async function setup(over: Parameters<typeof testApp>[3] = {}) {
  const app = testApp(immich.url, null, undefined, { mapHtml: HTML, ...over });
  const res = await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "<Leute>" } });
  expect(res.status).toBe(201);
  const made = (await res.json()) as MapCreated;
  const edit = `/api/m/${made.edit.token}`;
  const add = async (json: unknown) =>
    (await (await app.call(`${edit}/entries`, { method: "POST", json })).json()) as Entry;
  const view = async (token = made.edit.token) => (await (await app.call(`/api/m/${token}`)).json()) as MapView;
  return { app, made, edit, add, view };
}

describe("creating a map", () => {
  test("hands out a read link and a write link", async () => {
    const { made } = await setup();
    expect(made.view.role).toBe("view");
    expect(made.edit.role).toBe("edit");
    expect(made.view.url).toBe(`https://trip.example.org/m/${made.view.token}`);
    expect(made.edit.token).not.toBe(made.view.token);
  });

  test("validates the slug and refuses a taken one", async () => {
    const { app } = await setup();
    const post = (json: unknown) => app.call("/api/admin/maps", { method: "POST", admin: true, json });
    expect((await post({ slug: "Nope!", title: "x" })).status).toBe(400);
    expect((await post({ slug: "m", title: "x" })).status).toBe(409);
    expect((await post({ slug: "n", title: "x", extra: 1 })).status).toBe(400);
    expect((await post({ slug: "n", title: "x", settings: { a: 1 } })).status).toBe(400);
  });

  test("admin routes need the token", async () => {
    const { app } = await setup();
    expect((await app.call("/api/admin/maps")).status).toBe(401);
    expect((await app.call("/api/admin/maps/m/entries", { method: "POST", json: { name: "x" } })).status).toBe(401);
  });

  test("admin lists, reads, renames and deletes", async () => {
    const { app, add } = await setup();
    await add({ name: "A" });
    const list = (await (await app.call("/api/admin/maps", { admin: true })).json()) as MapSummary[];
    expect(list.map((m) => [m.slug, m.entries])).toEqual([["m", 1]]);
    const v = (await (await app.call("/api/admin/maps/m", { admin: true })).json()) as MapAdminView;
    expect(v.shares.map((s) => s.role)).toEqual(["view", "edit"]);
    expect(v.editable).toBe(true);
    const patched = await app.call("/api/admin/maps/m", { method: "PATCH", admin: true, json: { title: "Neu" } });
    expect(((await patched.json()) as { title: string }).title).toBe("Neu");
    expect((await app.call("/api/admin/maps/m", { method: "DELETE", admin: true })).status).toBe(204);
    expect((await app.call("/api/admin/maps/m", { admin: true })).status).toBe(404);
  });
});

describe("the page", () => {
  test("inlines the view, escapes the title and sets the map's CSP", async () => {
    const { app, made, add } = await setup();
    await add({ name: "</script><b>" });
    const res = await app.call(`/m/${made.view.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&#60;Leute&#62;");
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script>");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
  });

  test("carries a link preview with no people and no token in it", async () => {
    const { app, made, add } = await setup({
      mapHtml: "<head><!--OG--><title><!--TITLE--></title></head><script><!--MAP--></script>",
    });
    await add({ name: "Geheim", note: "privat", places: [place] });
    const html = await (await app.call(`/m/${made.edit.token}?e=1`)).text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('property="og:title" content="&#60;Leute&#62;"');
    expect(head).toContain('property="og:description" content="1 Eintrag · 1 Ort"');
    expect(head).toMatch(
      /property="og:image" content="https:\/\/trip\.example\.org\/preview\/[0-9a-f]{32}\.jpg\?v=\d+"/,
    );
    expect(head).toContain("<title>&#60;Leute&#62;</title>");
    for (const secret of ["Geheim", "privat", "Musterweg", made.edit.token, made.view.token])
      expect(head).not.toContain(secret);
  });

  test("answers 304 until the map changes", async () => {
    const { app, made, add } = await setup();
    const first = await app.call(`/m/${made.view.token}`);
    const etag = first.headers.get("etag") as string;
    expect((await app.call(`/m/${made.view.token}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    await add({ name: "A" });
    expect((await app.call(`/m/${made.view.token}`, { headers: { "if-none-match": etag } })).status).toBe(200);
  });

  test("the read page carries no write link", async () => {
    const { app, made } = await setup();
    const html = await (await app.call(`/m/${made.view.token}`)).text();
    expect(html).not.toContain(made.edit.token);
    expect(html).toContain('"view_url":null');
  });

  test("unknown and revoked tokens are not found", async () => {
    const { app, made } = await setup();
    expect((await app.call(`/m/${"a".repeat(22)}`)).status).toBe(404);
    expect((await app.call("/m/short")).status).toBe(404);
    const shares = (await (await app.call("/api/admin/maps/m/shares", { admin: true })).json()) as MapShare[];
    const del = await app.call(`/api/admin/maps/m/shares/${shares[1]?.id}`, { method: "DELETE", admin: true });
    expect(del.status).toBe(204);
    expect((await app.call(`/m/${made.edit.token}`)).status).toBe(404);
    expect((await app.call(`/api/m/${made.edit.token}`)).status).toBe(404);
    expect(
      (await app.call(`/api/admin/maps/m/shares/${shares[1]?.id}`, { method: "DELETE", admin: true })).status,
    ).toBe(404);
  });
});

describe("the view", () => {
  test("a view token reads and sends an ETag", async () => {
    const { app, made, add } = await setup();
    await add({ name: "Zoe", places: [place] });
    await add({ name: "Ärne", places: [place] });
    await add({ name: "Adam" });
    const res = await app.call(`/api/m/${made.view.token}`);
    const v = (await res.json()) as MapView;
    expect(v.editable).toBe(false);
    expect(v.entries.map((e) => e.name)).toEqual(["Ärne", "Zoe", "Adam"]);
    expect(v.view_url).toBeNull();
    const etag = res.headers.get("etag") as string;
    expect((await app.call(`/api/m/${made.view.token}`, { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  test("an edit token gets the read link and the trash", async () => {
    const { made, edit, add, app, view } = await setup();
    const e = await add({ name: "A" });
    await app.call(`${edit}/entries/${e.id}`, { method: "DELETE" });
    const v = await view();
    expect(v.editable).toBe(true);
    expect(v.view_url).toBe(made.view.url);
    expect(v.trash.map((x) => x.name)).toEqual(["A"]);
    expect((await view(made.view.token)).trash).toEqual([]);
  });

  test("a deleted entry goes for good only with the login, or by the admin", async () => {
    const { app, made, edit, add, view } = await setup();
    const a = await add({ name: "A" });
    const b = await add({ name: "B" });
    const purge = (id: number, init: Parameters<typeof app.call>[1] = {}) =>
      app.call(`${edit}/entries/${id}/purge`, { method: "DELETE", ...init });
    expect((await view()).can_purge).toBe(false);
    const viewer = await app.call(`/api/m/${made.view.token}`, { editor: true });
    expect(((await viewer.json()) as MapView).can_purge).toBe(false);
    const withLogin = (await (await app.call(edit, { editor: true })).json()) as MapView;
    expect(withLogin.can_purge).toBe(true);
    expect((await purge(a.id, { editor: true })).status).toBe(409);
    await app.call(`${edit}/entries/${a.id}`, { method: "DELETE" });
    await app.call(`${edit}/entries/${b.id}`, { method: "DELETE" });
    expect((await purge(a.id)).status).toBe(403);
    expect(
      (await app.call(`/api/m/${made.view.token}/entries/${a.id}/purge`, { method: "DELETE", editor: true })).status,
    ).toBe(403);
    expect((await purge(a.id, { editor: true })).status).toBe(204);
    expect((await app.call(`${edit}/entries/${a.id}`)).status).toBe(404);
    expect((await app.call(`/api/admin/maps/m/entries/${b.id}/purge`, { method: "DELETE", admin: true })).status).toBe(
      204,
    );
    expect((await view()).trash).toEqual([]);
  });

  test("the view's ETag tells the login apart", async () => {
    const { app, edit } = await setup();
    const plain = (await app.call(edit)).headers.get("etag") as string;
    expect((await app.call(edit, { editor: true, headers: { "if-none-match": plain } })).status).toBe(200);
  });

  test("every write bumps the map's rev", async () => {
    const { edit, add, app, view } = await setup();
    const r0 = (await view()).rev;
    const e = await add({ name: "A" });
    const r1 = (await view()).rev;
    await app.call(`${edit}/entries/${e.id}`, { method: "PATCH", json: { note: "x" } });
    const r2 = (await view()).rev;
    await app.call(`${edit}/entries/${e.id}`, { method: "DELETE" });
    const r3 = (await view()).rev;
    await app.call(`${edit}/entries/${e.id}/restore`, { method: "POST", json: {} });
    const r4 = (await view()).rev;
    expect([r0 < r1, r1 < r2, r2 < r3, r3 < r4]).toEqual([true, true, true, true]);
  });
});

describe("a read link", () => {
  test("is refused on every write", async () => {
    const { app, made, add } = await setup();
    const e = await add({ name: "A" });
    const base = `/api/m/${made.view.token}`;
    const calls: [string, string, unknown][] = [
      ["POST", "/entries", { name: "B" }],
      ["PATCH", `/entries/${e.id}`, { name: "B" }],
      ["DELETE", `/entries/${e.id}`, undefined],
      ["POST", `/entries/${e.id}/restore`, {}],
      ["GET", `/entries/${e.id}/history`, undefined],
    ];
    for (const [method, path, json] of calls) {
      const res = await app.call(base + path, { method, json });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("this link is read-only");
    }
  });
});

describe("entries", () => {
  test("create assigns place ids and walks through the colours", async () => {
    const { add } = await setup();
    const a = await add({ name: " Anna ", emoji: "🦊", note: "n", places: [place], by: "Ich" });
    const b = await add({ name: "Ben" });
    expect(a.name).toBe("Anna");
    expect(a.emoji).toBe("🦊");
    expect(a.by).toBe("Ich");
    expect(a.places[0]?.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(a.places[0]?.address).toBe(place.address);
    expect([a.color, b.color]).toEqual([0, 1]);
    const c = await add({ name: "C", color: 9 });
    const d = await add({ name: "D" });
    expect([c.color, d.color]).toEqual([9, 0]);
  });

  test("a retry with the same client_id finds the entry", async () => {
    const { app, edit, view } = await setup();
    const post = () => app.call(`${edit}/entries`, { method: "POST", json: { name: "A", client_id: "abc" } });
    const first = await post();
    const again = await post();
    expect([first.status, again.status]).toEqual([201, 200]);
    expect((await view()).entries).toHaveLength(1);
  });

  test("validation", async () => {
    const { app, edit } = await setup();
    const post = async (json: unknown) => (await app.call(`${edit}/entries`, { method: "POST", json })).status;
    expect(await post({ name: "x".repeat(81) })).toBe(400);
    expect(await post({ name: "   " })).toBe(400);
    expect(await post({ name: "A", emoji: "ab" })).toBe(400);
    expect(await post({ name: "A", color: 10 })).toBe(400);
    expect(await post({ name: "A", note: "x".repeat(2001) })).toBe(400);
    expect(await post({ name: "A", by: "x".repeat(41) })).toBe(400);
    expect(await post({ name: "A", client_id: "x".repeat(65) })).toBe(400);
    expect(await post({ name: "A", unknown: 1 })).toBe(400);
    expect(await post({ name: "A", places: Array(11).fill(place) })).toBe(400);
    expect(await post({ name: "A", places: [{ ...place, lat: 91 }] })).toBe(400);
    expect(await post({ name: "A", places: [{ ...place, label: "x".repeat(41) }] })).toBe(400);
    expect(await post({ name: "A", places: [{ ...place, address: "x".repeat(201) }] })).toBe(400);
    expect(await post({ name: "A", places: [{ ...place, extra: 1 }] })).toBe(400);
    expect(
      await post({
        name: "A",
        places: [
          { ...place, id: "a" },
          { ...place, id: "a" },
        ],
      }),
    ).toBe(400);
    expect(await post({ name: "A", emoji: "👩‍👩‍👧" })).toBe(201);
  });

  test("the map's limit counts deleted entries too", async () => {
    const { app, edit, add } = await setup({ limits: { max_entries: 2 } });
    const a = await add({ name: "A" });
    await add({ name: "B" });
    expect((await app.call(`${edit}/entries`, { method: "POST", json: { name: "C" } })).status).toBe(409);
    await app.call(`${edit}/entries/${a.id}`, { method: "DELETE" });
    expect((await app.call(`${edit}/entries`, { method: "POST", json: { name: "C" } })).status).toBe(409);
  });

  test("patch replaces the places and keeps ids that are given", async () => {
    const { app, edit, add } = await setup();
    const a = await add({ name: "A", places: [place, { ...place, label: "Arbeit" }] });
    const keep = a.places[1]?.id;
    const res = await app.call(`${edit}/entries/${a.id}`, {
      method: "PATCH",
      json: {
        places: [
          { ...place, id: keep, label: "Büro" },
          { ...place, label: "Eltern" },
        ],
      },
    });
    const e = (await res.json()) as EntryWritten;
    expect(e.places.map((p) => p.label)).toEqual(["Büro", "Eltern"]);
    expect(e.places[0]?.id).toBe(keep as string);
    expect(e.rev).toBe(2);
  });

  test("a write on a deleted entry brings it back and says so", async () => {
    const { app, edit, add, view } = await setup();
    const a = await add({ name: "A" });
    const url = `${edit}/entries/${a.id}`;
    await app.call(url, { method: "DELETE" });
    const e = (await (await app.call(url, { method: "PATCH", json: { note: "doch" } })).json()) as EntryWritten;
    expect(e.revived).toBe(true);
    expect(e.deleted_at).toBeNull();
    expect((await view()).entries.map((x) => x.note)).toEqual(["doch"]);
    const again = (await (await app.call(url, { method: "PATCH", json: { note: "x" } })).json()) as EntryWritten;
    expect(again.revived).toBe(false);
  });

  test("a retry for an entry deleted meanwhile brings it back; an empty client_id is none", async () => {
    const { app, edit, view } = await setup();
    const post = (client_id: string) => app.call(`${edit}/entries`, { method: "POST", json: { name: "A", client_id } });
    const e = (await (await post("abc")).json()) as Entry;
    await app.call(`${edit}/entries/${e.id}`, { method: "DELETE" });
    const again = await post("abc");
    expect(again.status).toBe(200);
    expect(((await again.json()) as Entry).deleted_at).toBeNull();
    expect((await post("")).status).toBe(201);
    expect((await post("")).status).toBe(201);
    expect((await view()).entries).toHaveLength(3);
  });

  test("writes have a budget per token; reads and the admin do not", async () => {
    const { app, edit, made, view } = await setup({ maps: { writes_per_minute: 2 } });
    const post = () => app.call(`${edit}/entries`, { method: "POST", json: { name: "A" } });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
    expect((await view()).entries).toHaveLength(2);
    expect((await app.call(`/api/m/${made.edit.token}`)).status).toBe(200);
    const admin = await app.call("/api/admin/maps/m/entries", { method: "POST", admin: true, json: { name: "B" } });
    expect(admin.status).toBe(201);
  });

  test("If-Match guards the write and answers with the current entry", async () => {
    const { app, edit, add } = await setup();
    const a = await add({ name: "A" });
    const url = `${edit}/entries/${a.id}`;
    await app.call(url, { method: "PATCH", json: { note: "1" }, headers: { "if-match": String(a.rev) } });
    const stale = await app.call(url, { method: "PATCH", json: { note: "2" }, headers: { "if-match": String(a.rev) } });
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { entry: Entry }).entry.note).toBe("1");
  });

  test("delete is soft, restore brings it back", async () => {
    const { app, edit, add, view } = await setup();
    const a = await add({ name: "A" });
    const url = `${edit}/entries/${a.id}`;
    const gone = await app.call(`${url}?by=Ich`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    const body = (await gone.json()) as EntryWritten;
    expect(body.deleted_at).not.toBeNull();
    expect(body.by).toBe("Ich");
    expect((await view()).entries).toEqual([]);
    expect(((await (await app.call(url)).json()) as Entry).deleted_at).not.toBeNull();
    expect((await app.call(url, { method: "DELETE" })).status).toBe(404);
    const back = await app.call(`${url}/restore`, { method: "POST", json: {} });
    expect(((await back.json()) as Entry).deleted_at).toBeNull();
    expect((await view()).trash).toEqual([]);
    expect((await app.call(`${url}/restore`, { method: "POST", json: {} })).status).toBe(409);
  });

  test("undo_rev puts the state before a write back, also after a delete", async () => {
    const { app, edit, add, view } = await setup();
    const a = await add({ name: "A", note: "alt", places: [place] });
    const url = `${edit}/entries/${a.id}`;
    const patched = (await (
      await app.call(url, { method: "PATCH", json: { note: "neu", places: [] } })
    ).json()) as EntryWritten;
    const undone = await app.call(`${url}/restore`, { method: "POST", json: { rev: patched.undo_rev } });
    const e = (await undone.json()) as Entry;
    expect(e.note).toBe("alt");
    expect(e.places).toEqual(a.places);
    const gone = (await (await app.call(url, { method: "DELETE" })).json()) as EntryWritten;
    await app.call(`${url}/restore`, { method: "POST", json: { rev: gone.undo_rev } });
    expect((await view()).entries.map((x) => x.note)).toEqual(["alt"]);
    expect((await app.call(`${url}/restore`, { method: "POST", json: { rev: 99999 } })).status).toBe(404);
  });

  test("history comes newest first and keeps its limit", async () => {
    const { app, edit, add } = await setup({ maps: { history_keep: 3 } });
    const a = await add({ name: "A" });
    const url = `${edit}/entries/${a.id}`;
    const one = await (await app.call(`${url}/history`)).json();
    expect((one as EntryRev[]).map((r) => r.action)).toEqual(["create"]);
    expect((one as EntryRev[])[0]?.snapshot.name).toBe("A");
    for (const note of ["1", "2", "3", "4"]) await app.call(url, { method: "PATCH", json: { note, by: "Ich" } });
    const revs = (await (await app.call(`${url}/history`)).json()) as EntryRev[];
    expect(revs).toHaveLength(3);
    expect(revs.map((r) => r.snapshot.note)).toEqual(["3", "2", "1"]);
    expect(revs[0]?.by).toBe("Ich");
    expect(revs[0]?.action).toBe("update");
  });

  test("an entry of another map is not found", async () => {
    const { app, add } = await setup();
    const a = await add({ name: "A" });
    const other = (await (
      await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "o", title: "O" } })
    ).json()) as MapCreated;
    expect((await app.call(`/api/m/${other.edit.token}/entries/${a.id}`)).status).toBe(404);
  });

  test("the admin edits through the same routes", async () => {
    const { app, view } = await setup();
    const res = await app.call("/api/admin/maps/m/entries", { method: "POST", admin: true, json: { name: "A" } });
    expect(res.status).toBe(201);
    expect((await view()).entries).toHaveLength(1);
  });

  test("the trash empties after its period and bumps the map", async () => {
    const { app, edit, add, view } = await setup();
    const a = await add({ name: "A" });
    const b = await add({ name: "B" });
    await app.call(`${edit}/entries/${a.id}`, { method: "DELETE" });
    const rev = (await view()).rev;
    expect(purgeEntries(app.store, 30, new Date())).toBe(0);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(purgeEntries(app.store, 30, later)).toBe(1);
    const v = await view();
    expect(v.rev).toBeGreaterThan(rev);
    expect(v.trash).toEqual([]);
    expect(v.entries.map((e) => e.id)).toEqual([b.id]);
  });
});

describe("shares", () => {
  test("another link of either role, and a bad role", async () => {
    const { app } = await setup();
    const post = (json: unknown) => app.call("/api/admin/maps/m/shares", { method: "POST", admin: true, json });
    const made = await post({ role: "edit", label: "neu" });
    expect(made.status).toBe(201);
    const s = (await made.json()) as { token: string; url: string };
    expect(s.url).toEndWith(`/m/${s.token}`);
    expect((await app.call(`/api/m/${s.token}`)).status).toBe(200);
    expect((await post({ role: "admin", label: "x" })).status).toBe(400);
  });

  test("creating and revoking a share reaches open pages", async () => {
    const { app, made } = await setup();
    const res = await app.call(`/api/m/${made.edit.token}`);
    const etag = res.headers.get("etag") as string;
    const fresh = await app.call("/api/admin/maps/m/shares", {
      method: "POST",
      admin: true,
      json: { role: "view", label: "2" },
    });
    const s = (await fresh.json()) as MapShare;
    const seen = await app.call(`/api/m/${made.edit.token}`, { headers: { "if-none-match": etag } });
    expect(seen.status).toBe(200);
    const etag2 = seen.headers.get("etag") as string;
    await app.call(`/api/admin/maps/m/shares/${s.id}`, { method: "DELETE", admin: true });
    const after = await app.call(`/api/m/${made.edit.token}`, { headers: { "if-none-match": etag2 } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as MapView).view_url).toBe(made.view.url);
  });

  test("the newest live view share is the one handed out", async () => {
    const { app, view } = await setup();
    const res = await app.call("/api/admin/maps/m/shares", {
      method: "POST",
      admin: true,
      json: { role: "view", label: "2" },
    });
    const s = (await res.json()) as { url: string };
    expect((await view()).view_url).toBe(s.url);
  });
});

describe("the start page", () => {
  test("lists the maps with their write link, only for the editor", async () => {
    const { app, made, add } = await setup();
    await add({ name: "A" });
    const page = await (await app.call("/", { editor: true })).text();
    expect(page).toContain("Karten");
    expect(page).toContain(`/m/${made.edit.token}`);
    expect(page).toContain("1 Eintrag");
    expect(page).not.toContain(made.view.token);
    const anon = await app.call("/", { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(await anon.text()).toBe("");
  });
});
