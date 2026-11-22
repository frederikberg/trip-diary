// scripts/trip.ts against a fake server that follows src/shared/api.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-admin-token";
const ASSET = "6e112a80-1111-4222-8333-444455556666";
const ASSET2 = "7f223b91-1111-4222-8333-444455556666";

interface Req {
  method: string;
  path: string;
  query: string;
  headers: Headers;
  body: any;
}
const seen: Req[] = [];

const anchor = { t: "2026-10-17T14:05:00+02:00", rule: "track", day: 1, dist_m: 3, km: 2, off_track: false };
let trip: any;
let nextMedia: number;
let changeAfterRead = false;

function reset() {
  seen.length = 0;
  nextMedia = 1;
  trip = {
    trip: {
      slug: "scratch",
      title: "Scratch",
      short_title: null,
      timezone: "Europe/Berlin",
      start_date: null,
      extra: {},
    },
    days: [],
    waypoints: [],
    notes: [],
    shares: [
      {
        id: 1,
        role: "view",
        label: "first",
        created: "2026-10-17T10:00:00+02:00",
        revoked_at: null,
        url: "https://t.example/VIEWTOKEN",
      },
    ],
    rev: 1,
  };
}

const json = (v: unknown, status = 200) => Response.json(v, { status });
const noContent = () => new Response(null, { status: 204 });

function note(key: string, body: any): any {
  return {
    key,
    kind: key.startsWith("d") ? "day" : "note",
    number: key.startsWith("d") ? null : Number(key),
    day: key.startsWith("d") ? Number(key.slice(1)) : null,
    lat: 50,
    lon: 7,
    title: "",
    text: "",
    created: "2026-10-17T14:00:00+02:00",
    updated: "2026-10-17T14:00:00+02:00",
    rev: 1,
    at: null,
    extra: {},
    media: [],
    anchor,
    ...body,
  };
}

const entry = (body: any) => ({
  id: 3,
  name: "x",
  emoji: null,
  color: 0,
  note: "",
  places: [],
  created: "",
  updated: "",
  rev: 2,
  by: null,
  deleted_at: null,
  ...body,
});

function mapRoute(m: string, url: URL, body: any): Response {
  const p = url.pathname.replace("/api/admin/maps", "").split("/").filter(Boolean);
  const share = (id: number, role: string, token: string) => ({
    id,
    role,
    label: "l",
    created: "",
    revoked_at: null,
    url: `https://t.example/m/${token}`,
    token,
  });
  if (p.length === 0) {
    if (m === "GET") return json([{ slug: "leute", title: "Leute", entries: 2, rev: 5 }]);
    return json(
      {
        map: { slug: body.slug, title: body.title, settings: {} },
        view: share(1, "view", "V"),
        edit: share(2, "edit", "E"),
      },
      201,
    );
  }
  if (p.length === 1) {
    if (m === "DELETE") return noContent();
    if (m === "PATCH") return json({ slug: p[0], title: body.title, settings: {} });
    return json({
      map: { slug: p[0], title: "Leute", settings: {} },
      entries: [entry({ name: "Anna", places: [{ id: "a", label: "Zuhause", address: "Weg 1", lat: 1, lon: 2 }] })],
      trash: [entry({ id: 4, name: "Weg", deleted_at: "x" })],
      editable: true,
      rev: 5,
      view_url: null,
      shares: [],
    });
  }
  if (p[1] === "meet") {
    if (m === "POST") return json({ members: [], centroid: null, result: null, stale: false, job: null }, 202);
    return json({
      members: [{ entry_id: 3 }],
      centroid: { lat: 1, lon: 2 },
      stale: true,
      job: null,
      result: {
        computed_at: "x",
        departure: "y",
        train_ok: true,
        notes: ["hinweis"],
        based_on: [{ entry_id: 3, name: "Anna" }],
        candidates: [
          {
            station: { name: "Fulda" },
            mean_min: 90,
            max_min: 125,
            legs: [{ entry_id: 3, minutes: 125, by: "train", station: "Köln Hbf", access_min: 20 }],
          },
        ],
      },
    });
  }
  if (p[1] === "geocode") return json([{ label: "Weg 1, 12345 Ort", lat: 1, lon: 2 }]);
  if (p[1] === "shares") {
    if (m === "GET") return json([share(1, "view", "V")]);
    if (m === "DELETE") return noContent();
    return json(share(9, body.role, "N"), 201);
  }
  if (p.length === 2) return json(entry(body), 201);
  if (p[3] === "restore") return json(entry({}));
  if (p[3] === "history")
    return json([{ id: 7, at: "now", by: "Ich", action: "update", snapshot: entry({ name: "Alt" }) }]);
  return json(entry({ ...body, undo_rev: 7 }));
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    const isJson = req.headers.get("content-type")?.includes("json");
    const body = text && isJson ? JSON.parse(text) : undefined;
    seen.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (url.pathname.startsWith("/api/admin/maps")) return mapRoute(req.method, url, body);
    const p = url.pathname.replace("/api/admin/trips", "").split("/").filter(Boolean);
    const m = req.method;
    if (p.length === 0) {
      if (m === "GET")
        return json([
          {
            slug: "scratch",
            title: "Scratch",
            days: trip.days.length,
            notes: trip.notes.length,
            media: 0,
            rev: trip.rev,
          },
        ]);
      return json(
        {
          trip: { ...trip.trip, ...body },
          view: {
            id: 1,
            role: "view",
            label: "view",
            created: "",
            revoked_at: null,
            url: "https://t.example/V",
            token: "V",
          },
          edit: {
            id: 2,
            role: "edit",
            label: "edit",
            created: "",
            revoked_at: null,
            url: "https://t.example/V#edit=E",
            token: "E",
          },
        },
        201,
      );
    }
    if (p[0] !== "scratch") return json({ error: "unknown trip" }, 404);
    if (p.length === 1) {
      if (m === "GET") {
        return json(trip);
      }
      trip.trip = { ...trip.trip, ...body };
      return json(trip.trip);
    }
    if (p[1] === "shares") {
      if (m === "GET") return json(trip.shares);
      if (m === "DELETE") return noContent();
      return json(
        {
          id: 9,
          role: body.role,
          label: body.label,
          created: "",
          revoked_at: null,
          url: "https://t.example/X#edit=Y",
          token: "Y",
        },
        201,
      );
    }
    if (p[1] === "days") {
      if (m === "DELETE") return noContent();
      const day = { n: Number(p[2]), ...body };
      trip.days.push(day);
      return json(day);
    }
    if (p[1] === "waypoints") {
      trip.waypoints = body;
      return json(body);
    }
    if (p[1] === "suggest") {
      return json([
        {
          immich_id: ASSET,
          type: "image",
          taken_at: "2026-10-17T14:00:00+02:00",
          lat: 50.1,
          lon: 7.2,
          attached_to: ["4"],
          nearest_note: { key: "4", dist_m: 35.4 },
          track: { day: 1, lat: 50.1, lon: 7.2 },
        },
      ]);
    }
    if (p[1] === "notes") {
      if (p.length === 2) {
        const number = body.number ?? trip.notes.filter((n: any) => n.number != null).length + 1;
        const n = note(String(number), {
          title: body.title ?? "",
          text: body.text ?? "",
          lat: body.lat === undefined ? 49.979 : body.lat,
          lon: body.lon === undefined ? 7.683 : body.lon,
          ...(body.created ? { created: body.created } : {}),
          extra: body.extra ?? {},
        });
        if (body.from_asset)
          n.media.push({ id: nextMedia++, type: "image", immich_id: body.from_asset, caption: null, position: 0 });
        trip.notes.push(n);
        return json(n, 201);
      }
      const n = trip.notes.find((x: any) => x.key === p[2]);
      if (!n) return json({ error: "no such note" }, 404);
      if (p.length === 3) {
        if (m === "GET") {
          const snapshot = structuredClone(n);
          if (changeAfterRead) n.rev++;
          return json(snapshot);
        }
        if (m === "DELETE") return noContent();
        const ifMatch = req.headers.get("if-match");
        if (ifMatch && Number(ifMatch) !== n.rev) return json({ error: "revision mismatch", note: n }, 412);
        Object.assign(n, body);
        n.rev++;
        return json(n);
      }
      if (p.length === 4 && m === "POST") {
        const media = {
          id: nextMedia++,
          type: "image",
          immich_id: body.immich_id,
          caption: body.caption ?? null,
          position: n.media.length,
        };
        n.media.push(media);
        return json(media, 201);
      }
      const idx = n.media.findIndex((x: any) => String(x.id) === p[4]);
      if (idx < 0) return json({ error: "no such media" }, 404);
      if (m === "DELETE") return noContent();
      const [mm] = n.media.splice(idx, 1);
      n.media.splice(body.position, 0, mm);
      n.media.forEach((x: any, i: number) => {
        x.position = i;
      });
      return json(mm);
    }
    return json({ error: "not found" }, 404);
  },
});

const dir = mkdtempSync(join(tmpdir(), "trip-test-"));
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, `${TOKEN}\n`);

async function trp(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "../scripts/trip.ts"),
      "--url",
      `http://localhost:${server.port}`,
      "--token-file",
      tokenFile,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

beforeAll(reset);
afterAll(() => server.stop(true));

describe("trips and links", () => {
  test("ls, new, links, share", async () => {
    reset();
    expect((await trp("ls")).out).toContain("scratch");
    const made = await trp("new", "scratch", "--title", "Scratch", "--timezone", "Europe/Berlin");
    expect(made.out).toContain("view  https://t.example/V");
    expect(seen.at(-1)?.body).toMatchObject({ slug: "scratch", timezone: "Europe/Berlin" });
    expect((await trp("links", "scratch")).out).toContain("https://t.example/VIEWTOKEN");
    expect((await trp("share", "scratch", "--label", "x")).out).toContain("https://t.example/");
    expect(seen.at(-1)?.body).toEqual({ role: "view", label: "x" });
    await trp("share", "scratch", "--revoke", "9");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/admin/trips/scratch/shares/9" });
  });

  test("a day offset is set as a number and show names the day the way it is shown", async () => {
    reset();
    const set = await trp("set", "scratch", "--day-offset", "-1");
    expect(set.code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ day_offset: -1 });
    trip.days = [{ n: 1, date: "2026-10-16", track: [], stats: null, end: null, source: null }];
    const out = (await trp("show", "scratch")).out;
    expect(out).toContain("day offset -1");
    expect(out).toContain("day 1 (Tag 0)  2026-10-16");
    expect((await trp("set", "scratch", "--day-offset", "x")).err).toContain("--day-offset needs a number");
    await trp("new", "prep", "--title", "P", "--timezone", "Europe/Berlin", "--day-offset", "-2");
    expect(seen.at(-1)?.body).toMatchObject({ slug: "prep", day_offset: -2 });
  });

  test("a wrong token surfaces the 401", async () => {
    writeFileSync(join(dir, "bad"), "nope");
    const p = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../scripts/trip.ts"),
        "--url",
        `http://localhost:${server.port}`,
        "--token-file",
        join(dir, "bad"),
        "ls",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("401");
  });
});

describe("days import", () => {
  test("puts each day and the waypoints in the API shape", async () => {
    reset();
    const f = join(dir, "days.json");
    writeFileSync(
      f,
      JSON.stringify({
        trip: { name: "x" },
        days: [
          {
            day: 2,
            date: "2026-10-18",
            track: [[50, 7, 100, "2026-10-18T08:00:00+02:00"]],
            stats: { km: 1 },
            end: { lat: 50, lon: 7, camp_type: "wild", name: "Camp" },
          },
        ],
        waypoints: [{ id: "w1", name: "Tap", kind: "tap", lat: 50, lon: 7, day: 2, notes: null, dist_to_track_m: 12 }],
      }),
    );
    const r = await trp("days", "import", "scratch", f);
    expect(r.code).toBe(0);
    const put = seen.find((s) => s.method === "PUT" && s.path.endsWith("/days/2"));
    expect(put?.body).toEqual({
      date: "2026-10-18",
      track: [[50, 7, 100, "2026-10-18T08:00:00+02:00"]],
      stats: { km: 1 },
      end: { lat: 50, lon: 7, camp_type: "wild", name: "Camp" },
      source: null,
    });
    expect(seen.find((s) => s.path.endsWith("/waypoints"))?.body[0]).toEqual({
      id: "w1",
      name: "Tap",
      kind: "tap",
      lat: 50,
      lon: 7,
      day: 2,
      passed_time: null,
      notes: null,
    });
  });
});

const GPX = (points: [string, string, string, string][]) =>
  `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${points
    .map(([lat, lon, ele, time]) => `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${time}</time></trkpt>`)
    .join("")}</trkseg></trk></gpx>`;

describe("days import-gpx", () => {
  test("one file per day, numbered from --first-day in date order, dated in the trip timezone", async () => {
    reset();
    // 22:30 UTC on the 16th is already the 17th in Berlin (UTC+2 in October).
    const late = join(dir, "late.gpx");
    const early = join(dir, "early.gpx");
    writeFileSync(
      late,
      GPX([
        ["50.0", "7.0", "100", "2026-10-16T22:30:00Z"],
        ["50.001", "7.0", "110", "2026-10-16T22:40:00Z"],
      ]),
    );
    writeFileSync(
      early,
      GPX([
        ["50.0", "7.0", "90", "2026-10-15T08:00:00Z"],
        ["50.002", "7.0", "95", "2026-10-15T08:10:00Z"],
      ]),
    );
    const r = await trp("days", "import-gpx", "scratch", late, early, "--first-day", "3");
    expect(r.code).toBe(0);
    const first = seen.find((x) => x.method === "PUT" && x.path.endsWith("/days/3"));
    const second = seen.find((x) => x.method === "PUT" && x.path.endsWith("/days/4"));
    expect(first?.body.date).toBe("2026-10-15");
    expect(first?.body.track[0]).toEqual([50, 7, 90, "2026-10-15T10:00:00+02:00"]);
    expect(first?.body.stats).toMatchObject({ km: 0.22, elapsed_time_min: 10, min_ele: 90, max_ele: 95 });
    expect(first?.body.end).toEqual({ lat: 50.002, lon: 7, camp_type: null, name: null });
    expect(first?.body.source).toEqual({ file: "early.gpx" });
    expect(second?.body.date).toBe("2026-10-17");
  });

  test("several recordings of one date make one day with breaks; a long pause with a jump splits a recording", async () => {
    reset();
    const a = join(dir, "ride1.gpx");
    const b = join(dir, "ride2.gpx");
    const c = join(dir, "next.gpx");
    // Morning ride, then a second file after the train (20 km away), then the next day.
    writeFileSync(
      a,
      GPX([
        ["50.0", "7.0", "100", "2026-10-15T06:00:00Z"],
        ["50.001", "7.0", "110", "2026-10-15T06:10:00Z"],
        ["50.002", "7.0", "120", "2026-10-15T06:20:00Z"],
      ]),
    );
    // One recording with a 1 h pause and a jump of about 20 km inside it.
    writeFileSync(
      b,
      GPX([
        ["50.2", "7.0", "100", "2026-10-15T08:00:00Z"],
        ["50.201", "7.0", "110", "2026-10-15T08:10:00Z"],
        ["50.4", "7.0", "100", "2026-10-15T09:20:00Z"],
        ["50.401", "7.0", "110", "2026-10-15T09:30:00Z"],
      ]),
    );
    writeFileSync(
      c,
      GPX([
        ["50.0", "7.0", "90", "2026-10-16T08:00:00Z"],
        ["50.002", "7.0", "95", "2026-10-16T08:10:00Z"],
      ]),
    );
    const r = await trp("days", "import-gpx", "scratch", c, b, a);
    expect(r.code).toBe(0);
    const day1 = seen.find((x) => x.method === "PUT" && x.path.endsWith("/days/1"));
    const day2 = seen.find((x) => x.method === "PUT" && x.path.endsWith("/days/2"));
    expect(day1?.body.breaks).toHaveLength(2);
    // Each break is a jump: the point before it is far from the point at it.
    const track = day1?.body.track as number[][];
    for (const i of (day1?.body.breaks ?? []) as number[]) {
      const lat = (k: number) => (track[k] as number[]).at(0) as number;
      expect(Math.abs(lat(i) - lat(i - 1))).toBeGreaterThan(0.1);
    }
    // Only the ridden stretches count: three rides of a few hundred metres each, not the 50 km between.
    expect(day1?.body.stats.km).toBeLessThan(1);
    expect(day1?.body.source).toEqual({ file: "ride1.gpx, ride2.gpx" });
    expect(day2?.body.breaks).toBeUndefined();
    expect(r.out).toContain("3 recordings");
  });

  test("a point without a time is refused before anything is sent", async () => {
    reset();
    const f = join(dir, "notime.gpx");
    writeFileSync(
      f,
      '<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkpt><trkpt lat="1" lon="2.1"></trkpt></trkseg></trk></gpx>',
    );
    const r = await trp("days", "import-gpx", "scratch", f);
    expect(r.code).toBe(1);
    expect(r.err).toContain("<time>");
    expect(seen.some((x) => x.method === "PUT")).toBe(false);
  });
});

describe("connection settings", () => {
  test("--url and the admin token may come from the environment; without them the CLI says what is missing", async () => {
    const run = (env: Record<string, string>) =>
      Bun.spawn(["bun", join(import.meta.dir, "../scripts/trip.ts"), "ls"], {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
    const none = run({});
    expect(await none.exited).toBe(1);
    expect(await new Response(none.stderr).text()).toContain("TRIP_URL");
    const noToken = run({ TRIP_URL: `http://localhost:${server.port}` });
    expect(await noToken.exited).toBe(1);
    expect(await new Response(noToken.stderr).text()).toContain("TRIP_ADMIN_TOKEN");
    const ok = run({ TRIP_URL: `http://localhost:${server.port}/`, TRIP_ADMIN_TOKEN: TOKEN });
    expect(await ok.exited).toBe(0);
    expect(await new Response(ok.stdout).text()).toContain("scratch");
  });
});

describe("notes", () => {
  test("add at a position, then set text, append, and a 412 is explained", async () => {
    reset();
    const a = await trp("note", "add", "scratch", "--lat", "-3.5", "--lon", "7.25", "--title", "Bridge");
    expect(a.code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ lat: -3.5, lon: 7.25, title: "Bridge" });
    await trp("note", "set", "scratch", "1", "--text", "first");
    await trp("note", "set", "scratch", "1", "--text", "second", "--append");
    const patch = seen.at(-1);
    expect(patch?.body.text).toBe("first\n\nsecond");
    expect(patch?.headers.get("if-match")).toBe("2");
    const shown = await trp("note", "scratch", "1");
    expect(shown.out).toContain("first\n\nsecond");

    changeAfterRead = true;
    const stale = await trp("note", "set", "scratch", "1", "--text", "x", "--append");
    changeAfterRead = false;
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("changed meanwhile");
  });

  test("text from stdin file, --at none clears, day-end key, bad key", async () => {
    reset();
    await trp("note", "add", "scratch", "--lat", "1", "--lon", "2");
    const tf = join(dir, "text.md");
    writeFileSync(tf, "from a file\n");
    await trp("note", "set", "scratch", "1", "--text-file", tf, "--at", "none");
    expect(seen.at(-1)?.body).toEqual({ at: null, text: "from a file\n" });
    expect((await trp("note", "set", "scratch", "x9", "--text", "a")).err).toContain("note key");
  });

  test("add from an Immich link uses the asset id; mv and rm", async () => {
    reset();
    const r = await trp(
      "note",
      "add",
      "scratch",
      "--from-asset",
      `https://photos.example.org/albums/${ASSET2}/photos/${ASSET}?x=1`,
    );
    expect(r.code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ from_asset: ASSET });
    await trp("note", "mv", "scratch", "1", "--lat", "50.5", "--lon", "7.5");
    expect(seen.at(-1)?.body).toEqual({ lat: 50.5, lon: 7.5 });
    await trp("note", "rm", "scratch", "1");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/admin/trips/scratch/notes/1" });
  });

  test("a note without a place: add, show, drop and regain a place", async () => {
    reset();
    const a = await trp(
      "note",
      "add",
      "scratch",
      "--no-place",
      "--at",
      "2026-10-17T21:30:00+02:00",
      "--title",
      "Abend",
    );
    expect(a.code).toBe(0);
    expect(seen.at(-1)?.body).toEqual({ lat: null, lon: null, title: "Abend", at: "2026-10-17T21:30:00+02:00" });
    expect(a.out).toContain("no-place");
    expect(a.out).toContain("pos no place");
    expect((await trp("note", "scratch", "1")).out).toContain("pos no place");
    await trp("note", "add", "scratch", "--lat", "1", "--lon", "2");
    await trp("note", "mv", "scratch", "2", "--no-place");
    expect(seen.at(-1)?.body).toEqual({ lat: null, lon: null });
    await trp("note", "mv", "scratch", "2", "--lat", "50.5", "--lon", "7.5");
    expect(seen.at(-1)?.body).toEqual({ lat: 50.5, lon: 7.5 });
    const n = seen.length;
    expect((await trp("note", "add", "scratch", "--no-place", "--lat", "1", "--lon", "2")).code).toBe(1);
    expect((await trp("note", "mv", "scratch", "2", "--no-place", "--lat", "1")).code).toBe(1);
    expect(seen.length).toBe(n);
  });

  test("arguments are validated before any request", async () => {
    reset();
    expect((await trp("note", "add", "scratch", "--lat", "1")).code).toBe(1);
    expect((await trp("note", "add", "scratch", "--from-asset", "not-an-id")).err).toContain("neither");
    expect(seen.length).toBe(0);
  });
});

describe("media", () => {
  test("attach, order, rm", async () => {
    reset();
    await trp("note", "add", "scratch", "--lat", "1", "--lon", "2");
    const r = await trp("media", "attach", "scratch", "1", ASSET, `https://x/photos/${ASSET2}`);
    expect(r.out).toContain("attached media 1");
    expect(seen.at(-1)?.body).toEqual({ immich_id: ASSET2 });
    const o = await trp("media", "order", "scratch", "1", "2", "1");
    expect(o.out).toContain("2 1");
    expect((await trp("media", "order", "scratch", "1", "77")).err).toContain("no media 77");
    await trp("media", "rm", "scratch", "1", "2");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/admin/trips/scratch/notes/1/media/2" });
    expect((await trp("media", "attach", "scratch", "1", ASSET, ASSET2, "--caption", "c")).err).toContain(
      "single asset",
    );
  });

  test("suggest: window from the day, offsets URL-encoded; rest day uses the trip zone", async () => {
    reset();
    trip.days = [
      {
        n: 1,
        date: "2026-10-17",
        track: [],
        stats: { start_time: "2026-10-17T08:00:00+02:00", end_time: "2026-10-17T16:30:00+02:00" },
        end: null,
        source: null,
      },
      { n: 2, date: "2026-10-25", track: [], stats: null, end: null, source: null },
    ];
    const r = await trp("media", "suggest", "scratch", "--day", "1", "--pad", "30");
    expect(r.out).toContain("nearest note 4 (35 m)");
    const q = new URLSearchParams(seen.at(-1)?.query);
    expect(q.get("from")).toBe("2026-10-17T07:30:00+02:00");
    expect(q.get("to")).toBe("2026-10-17T17:00:00+02:00");
    await trp("media", "suggest", "scratch", "--day", "2");
    const q2 = new URLSearchParams(seen.at(-1)?.query);
    // 2026-10-25 is the day the clocks go back: midnight is still +02:00, 23:59 is +01:00
    expect(q2.get("from")).toBe("2026-10-25T00:00:00+02:00");
    expect(q2.get("to")).toBe("2026-10-25T23:59:59+01:00");
  });
});

describe("export", () => {
  test("writes trip.json without shares and a file per note", async () => {
    reset();
    trip.notes = [
      note("1", { title: "T", text: "body", media: [{ id: 5, type: "image", immich_id: ASSET, caption: "cap" }] }),
    ];
    const out = join(dir, "export");
    const r = await trp("export", "scratch", out);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "trip.json"), "utf8")).shares).toBeUndefined();
    expect(readFileSync(join(out, "notes", "1.md"), "utf8")).toContain(`immich ${ASSET} image: cap`);
  });
});

describe("map", () => {
  test("--help lists the commands", async () => {
    const r = await trp("--help");
    for (const c of ["map new", "map links", "map share", "map geocode", "map entry add", "map entry restore"])
      expect(r.out).toContain(c);
  });

  test("ls, new, show, links, geocode", async () => {
    expect((await trp("map", "ls")).out).toContain("leute");
    const made = await trp("map", "new", "leute", "--title", "Leute");
    expect(made.out).toContain("view  https://t.example/m/V");
    expect(made.out).toContain("edit  https://t.example/m/E");
    const shown = (await trp("map", "show", "leute")).out;
    expect(shown).toContain("Anna  Zuhause: Weg 1");
    expect(shown).toContain("Weg  (deleted)");
    expect((await trp("map", "links", "leute")).out).toContain("/m/V");
    expect((await trp("map", "geocode", "leute", "Weg", "1")).out).toContain("Weg 1, 12345 Ort");
    expect(seen.at(-1)?.query).toBe("?q=Weg+1");
  });

  test("share and revoke", async () => {
    await trp("map", "share", "leute", "--role", "edit", "--label", "neu");
    expect(seen.at(-1)?.body).toEqual({ role: "edit", label: "neu" });
    expect((await trp("map", "share", "leute", "--revoke", "4")).out).toContain("revoked share 4");
    expect((await trp("map", "share", "leute")).code).toBe(1);
  });

  test("entries: places, a negative longitude, undo", async () => {
    const r = await trp(
      "map",
      "entry",
      "add",
      "leute",
      "--name",
      "Anna",
      "--place",
      "Zuhause|Weg 1, Ort|50.5|-3.25",
      "--place",
      "|Weg 2|1|2",
    );
    expect(r.code).toBe(0);
    expect(seen.at(-1)?.body.places).toEqual([
      { label: "Zuhause", address: "Weg 1, Ort", lat: 50.5, lon: -3.25 },
      { label: "", address: "Weg 2", lat: 1, lon: 2 },
    ]);
    expect((await trp("map", "entry", "add", "leute", "--place", "kaputt", "--name", "A")).code).toBe(1);
    const set = await trp("map", "entry", "set", "leute", "3", "--emoji", "none");
    expect(seen.at(-1)?.body).toEqual({ emoji: null });
    expect(set.out).toContain("--rev 7");
    expect((await trp("map", "entry", "rm", "leute", "3")).code).toBe(0);
    await trp("map", "entry", "restore", "leute", "3", "--rev", "7");
    expect(seen.at(-1)?.body).toEqual({ rev: 7 });
    expect((await trp("map", "entry", "history", "leute", "3")).out).toContain("update");
  });

  test("meet: set, show, compute", async () => {
    await trp("map", "meet", "set", "leute", "3", "--weight", "2", "--mode", "train");
    expect(seen.at(-1)?.body).toEqual({ weight: 2, mode: "train" });
    const shown = (await trp("map", "meet", "leute")).out;
    expect(shown).toContain("out of date");
    expect(shown).toContain("1. Fulda  mean 1:30  longest 2:05");
    expect(shown).toContain("2:05 train");
    expect(shown).toContain("ab Köln Hbf, +0:20");
    expect((await trp("map", "meet", "compute", "leute", "--wait")).code).toBe(0);
    expect((await trp("map", "meet", "rm", "leute", "3")).code).toBe(0);
  });

  test("avatar sends the file with its type", async () => {
    const f = join(dir, "a.png");
    writeFileSync(f, "x");
    expect((await trp("map", "entry", "avatar", "leute", "3", f)).code).toBe(0);
    expect(seen.at(-1)?.headers.get("content-type")).toBe("image/png");
    expect((await trp("map", "entry", "avatar", "leute", "3", "--clear")).code).toBe(0);
    expect((await trp("map", "entry", "avatar", "leute", "3", "a.gif")).code).toBe(1);
  });

  test("an unknown subcommand names the known ones", async () => {
    expect((await trp("map", "nope")).err).toContain("ls|new");
    expect((await trp("map", "entry", "nope")).err).toContain("add|set");
  });
});
