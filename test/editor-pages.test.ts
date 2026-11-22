// The editor's trip pages on the editing host: a new trip, a trip's settings and its read links,
// reachable through the proxy's login only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Share, TripAdminView, TripView } from "../src/shared/api";
import { localDate } from "../src/shared/time";
import { EDITOR_EMAIL, type FakeImmich, fakeImmich, seedTrip, type TestApp, testApp } from "./helpers";

let immich: FakeImmich;
let app: TestApp;
let sample: Awaited<ReturnType<typeof seedTrip>>;

beforeAll(async () => {
  immich = fakeImmich();
  app = testApp(immich.url);
  sample = await seedTrip(app, "sample");
});
afterAll(() => immich.stop());

const EDIT = "https://trip-edit.example.org";
const PUBLIC = "https://trip.example.org";

/** A form post as a browser sends it; `as` picks who sends it. */
function post(
  path: string,
  fields: Record<string, string>,
  as: { host?: string; email?: string | null; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const email = as.email === undefined ? EDITOR_EMAIL : as.email;
  const origin = as.origin === undefined ? EDIT : as.origin;
  if (email) headers["x-auth-request-email"] = email;
  if (origin) headers.origin = origin;
  return app.fetch(
    new Request(`${as.host ?? EDIT}${path}`, { method: "POST", headers, body: new URLSearchParams(fields) }),
  );
}

function get(path: string, as: { host?: string; email?: string | null } = {}): Promise<Response> {
  const email = as.email === undefined ? EDITOR_EMAIL : as.email;
  return app.fetch(
    new Request(`${as.host ?? EDIT}${path}`, { headers: email ? { "x-auth-request-email": email } : {} }),
  );
}

const admin = async (slug: string) =>
  (await (await app.call(`/api/admin/trips/${slug}`, { admin: true })).json()) as TripAdminView;

const NEW = {
  title: "Pyrenäen",
  slug: "pyrenaeen",
  short_title: "",
  timezone: "Europe/Paris",
  start_date: "2026-07-01",
  end_date: "",
};

const SETTINGS = {
  title: "Beispielwanderung",
  short_title: "Mittelgebirge",
  timezone: "Europe/Berlin",
  start_date: "2026-10-15",
  first_day: "1",
  delay_hours: "0",
};

describe("who reaches the pages", () => {
  /** Every write route, with a body that would succeed for the editor. */
  const writes = (shareId: number): [string, Record<string, string>][] => [
    ["/trips/new", { ...NEW, slug: "never-made" }],
    ["/trips/sample", { ...SETTINGS, title: "Übernommen" }],
    ["/trips/sample/end", {}],
    ["/trips/sample/shares", { label: "fremd" }],
    [`/trips/sample/shares/${shareId}/revoke`, {}],
  ];

  test("no write route answers anyone but the editor from the editing origin", async () => {
    const before = await admin("sample");
    const share = before.shares.find((s) => s.url?.endsWith(sample.view)) as Share;
    const refusals: [string, Parameters<typeof post>[2]][] = [
      ["a view-link reader on the public host", { host: PUBLIC, email: null, origin: PUBLIC }],
      ["a forged identity on the public host", { host: PUBLIC, origin: EDIT }],
      ["the editing host without a login", { email: null }],
      ["a login that may not edit", { email: "stranger@example.org" }],
      ["the editor without an Origin", { origin: null }],
      ["the editor from a foreign page", { origin: "https://evil.example" }],
      ["the editor from the public origin", { origin: PUBLIC }],
    ];
    for (const [path, fields] of writes(share.id))
      for (const [who, as] of refusals) {
        const r = await post(path, fields, as);
        expect({ path, who, status: r.status }).toEqual({ path, who, status: 403 });
      }
    const after = await admin("sample");
    expect(after.rev).toBe(before.rev);
    expect(after.trip.title).toBe(before.trip.title);
    expect(after.shares).toEqual(before.shares);
    expect(app.store.tripBySlug("never-made")).toBeNull();
  });

  test("a view token opens none of it", async () => {
    for (const path of ["/trip", "/settings", "/shares"]) {
      const r = await app.call(`/api/t/${sample.view}${path}`, { method: "POST", json: { label: "x" } });
      expect(r.status).toBe(403);
      const e = await app.call(`/api/t/${sample.view}${path}`, { method: "POST", editor: true, json: { label: "x" } });
      expect(e.status).toBe(404);
    }
  });

  test("the pages send other hosts to the editing host and show them nothing", async () => {
    for (const path of ["/trips/new", "/trips/sample"]) {
      const r = await get(path, { host: PUBLIC, email: null });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`${EDIT}${path}`);
      const body = await r.text();
      expect(body).not.toContain(sample.view);
      expect(body).not.toContain("Mittelgebirge");
      const forged = await get(path, { host: PUBLIC });
      expect(forged.status).toBe(302);
      expect((await get(path, { email: null })).status).toBe(403);
      const stranger = await get(path, { email: "stranger@example.org" });
      expect(stranger.status).toBe(403);
      expect(await stranger.text()).not.toContain(sample.view);
    }
  });

  test("with editing switched off the pages do not exist", async () => {
    const off = testApp(immich.url, null, undefined, { auth: { editor_from_header: false } });
    await seedTrip(off, "off");
    expect((await off.call("/trips/off", { editor: true })).status).toBe(404);
    expect((await off.call("/trips/new")).status).toBe(404);
  });

  test("the editor's pages run only their own script and post only here", async () => {
    const r = await get("/trips/sample");
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") as string;
    expect(csp).toContain("form-action 'self'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const hash = /sha256-([A-Za-z0-9+/=]+)/.exec(csp)?.[1];
    const script = /<script>([\s\S]*?)<\/script>/.exec(await r.text())?.[1] as string;
    expect(new Bun.CryptoHasher("sha256").update(script).digest("base64")).toBe(hash as string);
  });
});

describe("a new trip", () => {
  test("the start page offers it and each trip's settings", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('href="/trips/new"');
    expect(html).toContain('href="/trips/sample"');
  });

  test("the form makes a trip with the shape an import job watches, and opens it", async () => {
    const r = await post("/trips/new", NEW);
    expect(r.status).toBe(303);
    const v = await admin("pyrenaeen");
    expect(v.trip).toMatchObject({
      slug: "pyrenaeen",
      title: "Pyrenäen",
      short_title: null,
      timezone: "Europe/Paris",
      start_date: "2026-07-01",
      extra: { end_date: "open" },
      day_offset: 0,
    });
    const share = v.shares.find((s) => !s.revoked_at) as Share;
    expect(share.label).toBe("friends");
    expect(`${PUBLIC}${r.headers.get("location")}`).toBe(share.url as string);
    const opened = await app.call(`/api${r.headers.get("location")?.replace(/^\//, "/t/")}`, { editor: true });
    expect(((await opened.json()) as TripView).editable).toBe(true);
  });

  test("an end date is stored as the trip's last day", async () => {
    expect((await post("/trips/new", { ...NEW, slug: "kurz", end_date: "2026-07-05" })).status).toBe(303);
    expect((await admin("kurz")).trip.extra).toEqual({ end_date: "2026-07-05" });
  });

  test("a problem brings the form back with what was typed and a German sentence", async () => {
    const cases: [Record<string, string>, number, string][] = [
      [{ ...NEW }, 409, "hat schon eine Reise"],
      [{ ...NEW, slug: "Groß Buchstaben" }, 400, "Kleinbuchstaben"],
      [{ ...NEW, slug: "x".repeat(41) }, 400, "höchstens 40"],
      [{ ...NEW, slug: "z1", timezone: "Mars/Olympus" }, 400, "keine Zeitzone"],
      [{ ...NEW, slug: "z2", start_date: "" }, 400, "ersten Tag"],
      [{ ...NEW, slug: "z3", end_date: "2026-06-30" }, 400, "vor dem ersten"],
      [{ ...NEW, slug: "z4", title: " " }, 400, "Titel"],
      [{ ...NEW, slug: "z5", title: "x".repeat(201) }, 400, "Nicht angelegt"],
    ];
    for (const [fields, status, words] of cases) {
      const r = await post("/trips/new", fields);
      const html = await r.text();
      expect({ slug: fields.slug, status: r.status }).toEqual({ slug: fields.slug, status });
      expect(html).toContain(words);
      expect(html).toContain('name="slug"');
    }
    for (const slug of ["z1", "z2", "z3", "z4", "z5"]) expect(app.store.tripBySlug(slug)).toBeNull();
    expect(app.store.trips().filter((t) => t.slug === "pyrenaeen").length).toBe(1);
  });

  test("a form post needs a form body", async () => {
    const r = await app.fetch(
      new Request(`${EDIT}/trips/new`, {
        method: "POST",
        headers: { "x-auth-request-email": EDITOR_EMAIL, origin: EDIT, "content-type": "application/json" },
        body: JSON.stringify({ ...NEW, slug: "json" }),
      }),
    );
    expect(r.status).toBe(400);
    expect(app.store.tripBySlug("json")).toBeNull();
  });
});

describe("a trip's settings", () => {
  test("the page shows the trip, its read links and escapes what it shows", async () => {
    await app.call("/api/admin/trips/sample", { method: "PATCH", admin: true, json: { title: "<b>Wald</b>" } });
    const html = await (await get("/trips/sample")).text();
    expect(html).not.toContain("<b>Wald</b>");
    expect(html).toContain("&#60;b&#62;Wald&#60;/b&#62;");
    expect(html).toContain(`${PUBLIC}/${sample.view}`);
    expect(html).toContain("wird geteilt");
    expect(html).toContain(`href="/${sample.view}"`);
  });

  test("saving changes the trip and comes back to the settings", async () => {
    const before = await admin("sample");
    await app.call("/api/admin/trips/sample", { method: "PATCH", admin: true, json: { extra: { keep: 1 } } });
    const r = await post("/trips/sample", {
      ...SETTINGS,
      title: "Rundweg",
      short_title: "",
      first_day: "0",
      hide_camps: "1",
      delay_hours: "6",
      end_date: "2026-10-20",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/trips/sample?ok=saved");
    const v = await admin("sample");
    expect(v.rev).toBeGreaterThan(before.rev);
    expect(v.trip).toMatchObject({
      title: "Rundweg",
      short_title: null,
      timezone: "Europe/Berlin",
      start_date: "2026-10-15",
      privacy: { hide_camps: true, delay_hours: 6 },
      day_offset: -1,
    });
    // A trip without an end gets none from the form; other fields of `extra` stay.
    expect(v.trip.extra).toEqual({ keep: 1 });
    expect(await (await get("/trips/sample?ok=saved")).text()).toContain("Gespeichert.");
  });

  test("a bad field brings the settings back unsaved", async () => {
    const rev = (await admin("sample")).rev;
    for (const [fields, words] of [
      [{ ...SETTINGS, first_day: "1.5" }, "ganze Zahl"],
      [{ ...SETTINGS, first_day: "101" }, "ganze Zahl"],
      [{ ...SETTINGS, delay_hours: "-1" }, "ganze Zahl"],
      [{ ...SETTINGS, timezone: "" }, "Zeitzone"],
      [{ ...SETTINGS, start_date: "15.10.2026" }, "kein Datum"],
    ] as [Record<string, string>, string][]) {
      const r = await post("/trips/sample", fields);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain(words);
    }
    expect((await admin("sample")).rev).toBe(rev);
  });

  test("the last day of a watched trip is set, opened and ended today", async () => {
    const zone = "Europe/Paris";
    const base = { ...SETTINGS, timezone: zone, start_date: "2026-07-01" };
    expect((await post("/trips/pyrenaeen", { ...base, end_date: "2026-07-09" })).status).toBe(303);
    expect((await admin("pyrenaeen")).trip.extra).toEqual({ end_date: "2026-07-09" });
    expect(await (await get("/trips/pyrenaeen")).text()).not.toContain("Reise heute beenden");
    expect((await post("/trips/pyrenaeen/end", {})).status).toBe(409);
    expect((await post("/trips/pyrenaeen", { ...base, end_date: "" })).status).toBe(303);
    expect((await admin("pyrenaeen")).trip.extra).toEqual({ end_date: "open" });
    expect(await (await get("/trips/pyrenaeen")).text()).toContain("Reise heute beenden");
    const r = await post("/trips/pyrenaeen/end", {});
    expect(r.status).toBe(303);
    expect((await admin("pyrenaeen")).trip.extra).toEqual({ end_date: localDate(Date.now(), zone) });
    expect((await post("/trips/sample/end", {})).status).toBe(409);
  });

  test("an unknown trip is a 404", async () => {
    expect((await get("/trips/nope")).status).toBe(404);
    expect((await post("/trips/nope", SETTINGS)).status).toBe(404);
  });
});

describe("read links", () => {
  test("a new link becomes the one the trip page hands out", async () => {
    const r = await post("/trips/sample/shares", { label: "Familie" });
    expect(r.status).toBe(303);
    const v = await admin("sample");
    const made = v.shares.at(-1) as Share;
    expect(made).toMatchObject({ role: "view", label: "Familie", editor: false, revoked_at: null });
    const editable = (await (await app.call(`/api/t/${sample.view}`, { editor: true })).json()) as TripView;
    expect(editable.share_url).toBe(made.url);
    expect((await post("/trips/sample/shares", { label: " " })).status).toBe(400);
    expect((await post("/trips/sample/shares", { label: "x".repeat(101) })).status).toBe(400);
  });

  test("revoking a link stops it, and the editor opens the trip through the next one", async () => {
    const v = await admin("sample");
    const old = v.shares.find((s) => s.url?.endsWith(sample.view)) as Share;
    const next = v.shares.at(-1) as Share;
    const nextToken = next.url?.split("/").at(-1) as string;
    const r = await post(`/trips/sample/shares/${old.id}/revoke`, {});
    expect(r.status).toBe(303);
    expect((await app.call(`/api/t/${sample.view}`)).status).toBe(404);
    const home = await (await get("/")).text();
    expect(home).toContain(`href="/${nextToken}"`);
    const html = await (await get("/trips/sample")).text();
    expect(html).toContain("Widerrufene Links (1)");
    // This device's drafts under the revoked link gather on the link the editor opens the trip with.
    expect(html).toContain(`data-drafts-to="${nextToken}" data-drafts-from="${sample.view}"`);
  });

  test("the last live link, an editor's view token and a revoked one cannot be revoked here", async () => {
    const v = await admin("sample");
    const last = v.shares.find((s) => !s.revoked_at) as Share;
    const r = await post(`/trips/sample/shares/${last.id}/revoke`, {});
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("letzte Link");
    const revoked = v.shares.find((s) => s.revoked_at) as Share;
    expect((await post(`/trips/sample/shares/${revoked.id}/revoke`, {})).status).toBe(404);
    const trip = app.store.tripBySlug("sample")?.id as number;
    const editorShare = app.store.insertShare({
      trip_id: trip,
      role: "view",
      label: "old editor",
      token_hash: "editor-hash",
      token: "EDITORVIEWTOKENBBBBBB1",
      created: "2026-10-20T00:00:00Z",
      editor: 1,
      base_id: null,
    });
    expect((await post(`/trips/sample/shares/${editorShare.id}/revoke`, {})).status).toBe(404);
    expect(app.store.shareById(trip, editorShare.id)?.revoked_at).toBeNull();
    // Another trip's share is not this trip's.
    const other = (await admin("pyrenaeen")).shares[0] as Share;
    expect((await post(`/trips/sample/shares/${other.id}/revoke`, {})).status).toBe(404);
    // An editor's view token is never offered as a link.
    expect(await (await get("/trips/sample")).text()).not.toContain(`${PUBLIC}/EDITORVIEWTOKENBBBBBB1`);
  });
});

describe("day numbers", () => {
  test("the offset reaches every view and leaves the stored numbers alone", async () => {
    const t = await seedTrip(app, "offset");
    const read = async () => (await (await app.call(`/api/t/${t.view}`)).json()) as TripView;
    expect((await read()).trip.day_offset).toBe(0);
    const r = await app.call("/api/admin/trips/offset", { method: "PATCH", admin: true, json: { day_offset: -2 } });
    expect(r.status).toBe(200);
    const v = await read();
    expect(v.trip.day_offset).toBe(-2);
    expect(v.days[0]?.n).toBe(1);
    expect(v.notes.find((n) => n.kind === "day")?.key).toBe("d1");
    expect((await app.call("/api/admin/trips/offset/notes/d1", { admin: true })).status).toBe(200);
  });

  test("the offset is an integer from -99 to 99", async () => {
    for (const bad of [1.5, 100, -100, "1", null]) {
      const r = await app.call("/api/admin/trips/offset", { method: "PATCH", admin: true, json: { day_offset: bad } });
      expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
    }
    const made = await app.call("/api/admin/trips", {
      method: "POST",
      admin: true,
      json: { slug: "prep", title: "P", timezone: "Europe/Berlin", day_offset: -1 },
    });
    expect(made.status).toBe(201);
    expect((await made.json()).trip.day_offset).toBe(-1);
  });

  test("a database from before the offset opens with 0 for every trip", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const { MIGRATIONS, openDb, Store } = await import("../src/server/db");
    const path = join(mkdtempSync(join(tmpdir(), "trip-upgrade-")), "trip.db");
    const old = new Database(path, { create: true });
    for (const [i, m] of MIGRATIONS.slice(0, -1).entries()) {
      old.exec(m);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    old.exec("INSERT INTO trip (id, slug, title, timezone, created) VALUES (1, 't', 'T', 'Europe/Berlin', 'x')");
    old.close();
    expect(new Store(openDb(path)).tripById(1)?.day_offset).toBe(0);
  });
});
