// Capability tokens: view tokens open one trip read-only, the proxy's login on the editing host
// makes every trip editable, admin needs the bearer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashToken, sameSecret } from "../src/server/tokens";
import type { Share, TripView } from "../src/shared/api";
import { ADMIN_TOKEN, EDITOR_EMAIL, type FakeImmich, fakeImmich, seedTrip, type TestApp, testApp } from "./helpers";

let immich: FakeImmich;
let app: TestApp;
let a: Awaited<ReturnType<typeof seedTrip>>;
let b: Awaited<ReturnType<typeof seedTrip>>;

beforeAll(async () => {
  immich = fakeImmich();
  app = testApp(immich.url);
  a = await seedTrip(app, "trip-a");
  b = await seedTrip(app, "trip-b");
});
afterAll(() => immich.stop());

const place = (token: string, init: { editor?: boolean; headers?: Record<string, string> } = {}) =>
  app.call(`/api/t/${token}/notes`, { method: "POST", json: { lat: 49.8, lon: 7.45 }, ...init });

describe("view tokens", () => {
  test("a view token reads its trip, not editable", async () => {
    const res = await app.call(`/api/t/${a.view}`);
    expect(res.status).toBe(200);
    const v = (await res.json()) as TripView;
    expect(v.trip.slug).toBe("trip-a");
    expect(v.editable).toBe(false);
  });

  test("unknown and malformed tokens are not view tokens", async () => {
    expect((await app.call("/api/t/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await app.call("/api/t/short")).status).toBe(404);
  });

  test("a revoked view token stops working", async () => {
    const res = await app.call("/api/admin/trips/trip-a/shares", {
      method: "POST",
      admin: true,
      json: { role: "view", label: "friends" },
    });
    const share = (await res.json()) as { id: number; token: string; url: string };
    expect(share.url).toBe(`https://trip.example.org/${share.token}`);
    expect((await app.call(`/api/t/${share.token}`)).status).toBe(200);
    expect(
      (await app.call(`/api/admin/trips/trip-a/shares/${share.id}`, { method: "DELETE", admin: true })).status,
    ).toBe(204);
    expect((await app.call(`/api/t/${share.token}`)).status).toBe(404);
    expect((await app.call(`/api/t/${a.view}`)).status).toBe(200);
  });
});

describe("editor", () => {
  const identity = { "x-auth-request-email": EDITOR_EMAIL, origin: "https://trip-edit.example.org" };
  /** A request to the public host that carries the identity header anyway, as a forged one would. */
  const forged = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    app.fetch(
      new Request(`https://trip.example.org${path}`, {
        method: init.method ?? "GET",
        headers: { ...identity, "content-type": "application/json" },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      }),
    );

  test("writing needs the editor", async () => {
    expect((await place(a.view)).status).toBe(403);
    expect((await place(a.view, { headers: { "x-edit-key": a.view } })).status).toBe(403);
    expect((await place(a.view, { editor: true })).status).toBe(201);
  });

  test("the identity header on the public host is no edit right", async () => {
    expect((await forged(`/api/t/${a.view}/notes`, { method: "POST", json: { lat: 49.8, lon: 7.45 } })).status).toBe(
      403,
    );
    const v = (await (await forged(`/api/t/${a.view}`)).json()) as TripView;
    expect(v.editable).toBe(false);
  });

  test("a write must come from the editing host's own origin", async () => {
    const call = (origin?: string) =>
      app.fetch(
        new Request(`https://trip-edit.example.org/api/t/${a.view}/notes`, {
          method: "POST",
          headers: {
            "x-auth-request-email": EDITOR_EMAIL,
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ lat: 49.8, lon: 7.45 }),
        }),
      );
    expect((await call()).status).toBe(403);
    expect((await call("https://evil.example")).status).toBe(403);
    expect((await call("https://trip.example.org")).status).toBe(403);
    expect((await call("https://trip-edit.example.org")).status).toBe(201);
  });

  test("an address that may not edit gets a read-only view", async () => {
    const other = (path: string) =>
      app.fetch(
        new Request(`https://trip-edit.example.org${path}`, {
          method: "POST",
          headers: {
            "x-auth-request-email": "stranger@example.org",
            origin: "https://trip-edit.example.org",
            "content-type": "application/json",
          },
          body: JSON.stringify({ lat: 49.8, lon: 7.45 }),
        }),
      );
    expect((await other(`/api/t/${a.view}/notes`)).status).toBe(403);
    const r = await app.fetch(
      new Request(`https://trip-edit.example.org/api/t/${a.view}`, {
        headers: { "x-auth-request-email": "stranger@example.org" },
      }),
    );
    expect(((await r.json()) as TripView).editable).toBe(false);
  });

  test("the allowed address is compared without case", async () => {
    const r = await app.fetch(
      new Request(`https://trip-edit.example.org/api/t/${a.view}`, {
        headers: { "x-auth-request-email": EDITOR_EMAIL.toUpperCase() },
      }),
    );
    expect(((await r.json()) as TripView).editable).toBe(true);
  });

  test("the editor edits every trip through any of its view links", async () => {
    expect((await place(b.view, { editor: true })).status).toBe(201);
    const v = (await (await app.call(`/api/t/${b.view}`, { editor: true })).json()) as TripView;
    expect(v.editable).toBe(true);
    expect(v.share_url).toBe(`https://trip.example.org/${b.view}`);
  });

  test("without the login the view stays read-only", async () => {
    const r = (await (await app.call(`/api/t/${a.view}`)).json()) as TripView;
    expect(r.editable).toBe(false);
    expect(r.share_url).toBeNull();
  });

  test("the trip page carries the editable view only for the editor, with its own ETag", async () => {
    const html = "<html><title><!--TITLE--></title><script><!--TRIP--></script></html>";
    const pages = testApp(immich.url, html, undefined, {});
    const t = await seedTrip(pages, "page-trip");
    const open = await pages.call(`/${t.view}`);
    const edit = await pages.call(`/${t.view}`, { editor: true });
    expect(open.headers.get("etag")).not.toBe(edit.headers.get("etag"));
    expect(await open.text()).toContain('"editable":false');
    expect(await edit.text()).toContain('"editable":true');
  });

  test("with the switch off nobody edits and the start page does not exist", async () => {
    const off = testApp(immich.url, null, undefined, { auth: { editor_from_header: false } });
    const t = await seedTrip(off, "off-trip");
    expect(
      (await off.call(`/api/t/${t.view}/notes`, { method: "POST", editor: true, json: { lat: 49.8, lon: 7.45 } }))
        .status,
    ).toBe(403);
    expect((await off.call("/")).status).toBe(404);
  });

  test("the session cookie of earlier versions grants nothing", async () => {
    expect((await place(a.view, { headers: { cookie: "__Host-trip_session=AAAAAAAAAAAAAAAAAAAAAA" } })).status).toBe(
      403,
    );
  });

  test("an earlier edit share grants nothing and shares can no longer be made", async () => {
    const trip = app.store.tripBySlug("trip-a")?.id as number;
    const base = app.store.insertShare({
      trip_id: trip,
      role: "view",
      label: "old editor",
      token_hash: hashToken("TOKENTOKENTOKENTOKEN12"),
      token: "TOKENTOKENTOKENTOKEN12",
      created: "2026-10-20T00:00:00Z",
      editor: 1,
      base_id: null,
    });
    app.store.insertShare({
      trip_id: trip,
      role: "edit",
      label: "old",
      token_hash: hashToken("EDITEDITEDITEDITEDIT22"),
      token: null,
      created: "2026-10-20T00:00:00Z",
      editor: 0,
      base_id: base.id,
    });
    const r = await app.call("/api/t/TOKENTOKENTOKENTOKEN12/notes", {
      method: "POST",
      json: { lat: 49.8, lon: 7.45 },
      headers: { "x-edit-key": "EDITEDITEDITEDITEDIT22" },
    });
    expect(r.status).toBe(403);
    const mk = await app.call("/api/admin/trips/trip-a/shares", {
      method: "POST",
      admin: true,
      json: { role: "edit", label: "phone" },
    });
    expect(mk.status).toBe(400);
  });

  test("a new trip comes with a friends' link only", () => {
    expect(a.created.view.url).toBe(`https://trip.example.org/${a.view}`);
    expect(a.created.view.editor).toBe(false);
    expect("edit" in a.created).toBe(false);
  });

  test("a bad label leaves no share behind", async () => {
    const before = app.store.shares(app.store.tripBySlug("trip-b")?.id as number).length;
    const res = await app.call("/api/admin/trips/trip-b/shares", {
      method: "POST",
      admin: true,
      json: { role: "view", label: "x".repeat(500) },
    });
    expect(res.status).toBe(400);
    expect(app.store.shares(app.store.tripBySlug("trip-b")?.id as number).length).toBe(before);
  });

  test("view tokens are stored, an earlier edit token is not", () => {
    const shares = app.store.shares(app.store.tripBySlug("trip-a")?.id as number);
    expect(shares.filter((s) => s.role === "edit").every((s) => s.token === null)).toBe(true);
    expect(shares.filter((s) => s.role === "view").every((s) => typeof s.token === "string")).toBe(true);
  });

  test("the session routes of earlier versions are gone", async () => {
    expect((await app.call("/api/admin/sessions", { method: "DELETE", admin: true })).status).toBe(404);
    expect((await app.call("/auth/login", { headers: { "x-auth-request-email": EDITOR_EMAIL } })).status).toBe(404);
    expect((await app.call("/api/logout", { method: "POST" })).status).toBe(404);
  });
});

describe("upgrading a 0.1 database", () => {
  test("a database from before maps opens, migrates and keeps its shares", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const { MIGRATIONS, openDb, Store } = await import("../src/server/db");
    const path = join(mkdtempSync(join(tmpdir(), "trip-upgrade-")), "trip.db");
    const old = new Database(path, { create: true });
    for (const [i, m] of MIGRATIONS.slice(0, 2).entries()) {
      old.exec(m);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    old.exec(`INSERT INTO trip (id, slug, title, timezone, created) VALUES (1, 't', 'T', 'Europe/Berlin', '2026-10-20T00:00:00Z');
      INSERT INTO share (trip_id, role, label, token_hash, token, created, editor) VALUES
        (1, 'view', 'default', 'h1', 'tok1', '2026-10-20T00:00:00Z', 1);`);
    old.close();
    const store = new Store(openDb(path));
    expect(store.shares(1).length).toBe(1);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'session'").get()).toBeNull();
  });
});

describe("upgrading to notes without a place", () => {
  test("rebuilding the note table keeps every note and its media", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const { MIGRATIONS, openDb, Store } = await import("../src/server/db");
    const path = join(mkdtempSync(join(tmpdir(), "trip-upgrade-")), "trip.db");
    const old = new Database(path, { create: true });
    old.exec("PRAGMA foreign_keys = ON");
    for (const [i, m] of MIGRATIONS.slice(0, 6).entries()) {
      old.exec(m);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    old.exec(`INSERT INTO trip (id, slug, title, timezone, created) VALUES (1, 't', 'T', 'Europe/Berlin', '2026-10-20T00:00:00Z');
      INSERT INTO note (id, trip_id, kind, number, lat, lon, title, created, updated, rev, client_id) VALUES
        (7, 1, 'note', 3, 49.8, 7.4, 'Bach', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 4, 'c1');
      INSERT INTO note (id, trip_id, kind, day_n, created, updated) VALUES (8, 1, 'day', 1, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
      INSERT INTO media (trip_id, note_id, position, source, immich_id, type, v, created) VALUES
        (1, 7, 0, 'immich', 'a1', 'image', 'v', '2026-10-20T00:00:00Z'),
        (1, 8, 0, 'immich', 'a2', 'image', 'v', '2026-10-20T00:00:00Z');`);
    old.close();
    const store = new Store(openDb(path));
    expect(store.notes(1).map((n) => [n.id, n.number, n.title, n.rev, n.client_id])).toEqual([
      [7, 3, "Bach", 4, "c1"],
      [8, null, "", 1, null],
    ]);
    expect(store.mediaOfTrip(1).map((m) => [m.note_id, m.immich_id])).toEqual([
      [7, "a1"],
      [8, "a2"],
    ]);
    const insert = (at: string | null) =>
      store.db
        .query(
          "INSERT INTO note (trip_id, kind, number, created, updated, at) VALUES (1, 'note', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', ?)",
        )
        .run(at ? 4 : 5, at);
    insert("2026-10-20T12:00:00Z");
    expect(() => insert(null)).toThrow();
    expect(() =>
      store.db
        .query(
          "INSERT INTO note (trip_id, kind, number, created, updated, at, client_id) VALUES (1, 'note', 6, 'x', 'x', 'x', 'c1')",
        )
        .run(),
    ).toThrow();
    // Foreign keys are on again: deleting the note takes its media along.
    store.db.query("DELETE FROM note WHERE id = 7").run();
    expect(store.mediaOfTrip(1).map((m) => m.immich_id)).toEqual(["a2"]);
  });
});

describe("admin", () => {
  test("admin routes need the bearer token", async () => {
    expect((await app.call("/api/admin/trips")).status).toBe(401);
    expect((await app.call("/api/admin/trips", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.call("/api/admin/trips", { headers: { authorization: ADMIN_TOKEN } })).status).toBe(401);
    expect((await app.call("/api/admin/trips", { admin: true })).status).toBe(200);
  });

  test("the secret comparison ignores length differences", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "abc")).toBe(false);
  });

  test("shares list without leaking tokens of earlier edit shares", async () => {
    const list = (await (await app.call("/api/admin/trips/trip-a/shares", { admin: true })).json()) as Share[];
    expect(list.find((s) => s.role === "edit")?.url).toBeNull();
  });
});

describe("responses", () => {
  test("every response is noindex and leaks no token through the referrer", async () => {
    for (const path of [`/api/t/${a.view}`, "/api/t/AAAAAAAAAAAAAAAAAAAAAA", "/healthz", `/${a.view}`]) {
      const res = await app.call(path);
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    }
    expect(await (await app.call("/robots.txt")).text()).toContain("Disallow: /");
  });
});

describe("start page", () => {
  let on: TestApp;
  let t: Awaited<ReturnType<typeof seedTrip>>;

  beforeAll(async () => {
    on = testApp(immich.url);
    t = await seedTrip(on, "login-trip");
  });

  test("the public host sends / to the editing host", async () => {
    const r = await on.call("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://trip-edit.example.org/");
    expect(await r.text()).not.toContain("login-trip");
  });

  test("a login the app does not know is refused on the editing host", async () => {
    const r = await on.fetch(
      new Request("https://trip-edit.example.org/", { headers: { "x-auth-request-email": "stranger@example.org" } }),
    );
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain("login-trip");
  });

  test("the editor's / lists the trips", async () => {
    const page = await on.call("/", { editor: true });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(`href="/${t.view}"`);
    expect(html).toContain("5 Tage");
    expect(html).toContain('href="/oauth2/sign_out"');
  });

  test("a trip links its editor view token first, else its newest link", async () => {
    const tripId = on.store.tripBySlug("login-trip")?.id as number;
    on.store.insertShare({
      trip_id: tripId,
      role: "view",
      label: "old (editor)",
      token_hash: hashToken("EDITORVIEWTOKENAAAAAA1"),
      token: "EDITORVIEWTOKENAAAAAA1",
      created: "2026-10-20T00:00:00Z",
      editor: 1,
      base_id: null,
    });
    const html = await (await on.call("/", { editor: true })).text();
    expect(html).toContain('href="/EDITORVIEWTOKENAAAAAA1"');
    expect(html).not.toContain(`href="/${t.view}"`);
    on.store.revokeShare(tripId, on.store.shares(tripId).find((s) => s.editor)?.id as number, "2026-10-21T00:00:00Z");
    expect(await (await on.call("/", { editor: true })).text()).toContain(`href="/${t.view}"`);
  });

  test("the trip titles are escaped", async () => {
    await on.call("/api/admin/trips/login-trip", { method: "PATCH", admin: true, json: { title: "<b>x</b>" } });
    const html = await (await on.call("/", { editor: true })).text();
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
  });
});
