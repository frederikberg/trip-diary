// The switches: maps and the meeting point answer 404 while off; the identity header and the sign-out path are config.
import { afterAll, describe, expect, test } from "bun:test";
import type { MapCreated, MapView, TripView } from "../src/shared/api";
import { EDITOR_EMAIL, fakeImmich, seedTrip, testApp } from "./helpers";

const immich = fakeImmich();
afterAll(() => immich.stop());

const HTML = "<title><!--TITLE--></title><script><!--MAP--></script>";

describe("maps off", () => {
  const app = testApp(immich.url, null, undefined, {
    mapHtml: HTML,
    maps: { enabled: false },
    meet: { enabled: false },
  });

  test("every map route answers 404, the admin API included", async () => {
    const abcd = "A".repeat(22);
    for (const path of [`/m/${abcd}`, `/api/m/${abcd}`, `/api/m/${abcd}/meet`, "/preview/x.jpg", "/api/admin/maps"]) {
      const r = await app.call(path, { admin: true });
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect(
      (await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "x" } })).status,
    ).toBe(404);
  });

  test("the trips still work", async () => {
    const s = await seedTrip(app);
    expect((await app.call(`/api/t/${s.view}`)).status).toBe(200);
    expect((await app.call("/", { editor: true })).status).toBe(200);
  });
});

describe("meeting point off", () => {
  const app = testApp(immich.url, null, undefined, { mapHtml: HTML, meet: { enabled: false } });

  test("the map works, announces the switch and refuses the meeting point's routes", async () => {
    const made = (await (
      await app.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "Leute" } })
    ).json()) as MapCreated;
    const v = (await (await app.call(`/api/m/${made.edit.token}`)).json()) as MapView;
    expect(v.meet_enabled).toBe(false);
    for (const [method, path] of [
      ["GET", `/api/m/${made.edit.token}/meet`],
      ["POST", `/api/m/${made.edit.token}/meet/compute`],
      ["PUT", `/api/m/${made.edit.token}/meet/members/1`],
      ["GET", "/api/admin/maps/m/meet"],
    ] as const) {
      const r = await app.call(path, {
        method,
        admin: path.includes("admin"),
        json: method === "GET" ? undefined : {},
      });
      expect([path, r.status]).toEqual([path, 404]);
    }
  });

  test("with the switch on, the view says so", async () => {
    const on = testApp(immich.url, null, undefined, { mapHtml: HTML });
    const made = (await (
      await on.call("/api/admin/maps", { method: "POST", admin: true, json: { slug: "m", title: "Leute" } })
    ).json()) as MapCreated;
    expect(((await (await on.call(`/api/m/${made.edit.token}`)).json()) as MapView).meet_enabled).toBe(true);
  });
});

describe("another proxy's identity header and sign-out path", () => {
  const app = testApp(immich.url, null, undefined, {
    auth: { identity_header: "Remote-Email", sign_out_path: "/outpost/sign_out" },
  });

  test("only the configured header logs the editor in", async () => {
    const s = await seedTrip(app);
    const asEditor = (header: string) =>
      app.fetch(new Request(`${app.config.server.edit_url}/api/t/${s.view}`, { headers: { [header]: EDITOR_EMAIL } }));
    expect(((await (await asEditor("Remote-Email")).json()) as TripView).editable).toBe(true);
    expect(((await (await asEditor("X-Auth-Request-Email")).json()) as TripView).editable).toBe(false);
  });

  test("the start page and the editable view point at the configured sign-out", async () => {
    const s = await seedTrip(app, "second");
    const page = await app.call("/", { editor: true });
    expect(await page.text()).toContain('href="/outpost/sign_out"');
    const v = (await (await app.call(`/api/t/${s.view}`, { editor: true })).json()) as TripView;
    expect(v.sign_out_path).toBe("/outpost/sign_out");
    const reader = (await (await app.call(`/api/t/${s.view}`)).json()) as TripView;
    expect(reader.sign_out_path).toBeNull();
  });
});
