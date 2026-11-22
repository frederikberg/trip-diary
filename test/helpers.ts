// A fake Immich and an app instance on a temporary database, for the tests and the self-test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import type { Config } from "../src/server/config";
import { openDb, Store } from "../src/server/db";
import { Geocoder } from "../src/server/geocode";
import { Immich } from "../src/server/immich";
import stations from "../src/server/stations.json";
import { createTravel } from "../src/server/travel";
import type { Day, TripCreated, Waypoint } from "../src/shared/api";
import fixture from "./fixtures/hike.json";

export const IMMICH_KEY = "fake-immich-key-0123456789";
export const ADMIN_TOKEN = "admin-token-for-tests-0123456789";
/** The address the proxy would announce for the editor, and the one `auth.allowed_emails` holds. */
export const IDENTITY_HEADER = "X-Auth-Request-Email";
export const EDITOR_EMAIL = "owner@example.org";

export interface FakeAsset {
  id: string;
  type: "IMAGE" | "VIDEO";
  width: number;
  height: number;
  taken_at: string;
  lat?: number;
  lon?: number;
  duration_ms?: number;
  /** Fill colour of the generated picture. */
  colour?: string;
  /** In Immich's trash. */
  trashed?: boolean;
  /** Video playback that sends a chunk every 50 ms and never ends. */
  endless?: boolean;
  /** Owned by another user: reachable only while a shared album holds it. */
  foreign?: boolean;
}

export interface FakeImmich {
  url: string;
  assets: Map<string, FakeAsset>;
  /** Albums shared with the key's user: album id → the ids of the assets in it. */
  albums: Map<string, string[]>;
  /** Whether the key has album.read; without it the album list answers 403. */
  albumRead: boolean;
  requests: { method: string; path: string; key: string | null; range: string | null; body?: unknown }[];
  /** Make every media request fail with this status. */
  failWith: number | null;
  stop(): void;
}

interface FakeFilter {
  takenAt: { gte: string; lt: string };
  type?: { in: string[] };
  albumIds?: { any: string[] };
  /** `{eq: null}` leaves trashed assets out; without it they are found, as in Immich. */
  trashedAt?: { eq: null };
  or?: Omit<FakeFilter, "takenAt" | "trashedAt" | "or">[];
}

/** A video body of this many bytes; Range requests get the matching slice. */
export const VIDEO_BYTES = 10_000;

const svg = (a: FakeAsset, w: number, h: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `<rect width="${w}" height="${h}" fill="${a.colour ?? "#7a9e7e"}"/>` +
  `<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="#f6e7b4"/>` +
  `<path d="M0 ${h} L${w * 0.35} ${h * 0.45} L${w * 0.6} ${h * 0.75} L${w * 0.8} ${h * 0.55} L${w} ${h}Z" fill="#3f5e47"/>` +
  `<text x="${w / 2}" y="${h * 0.92}" font-size="${Math.round(h / 14)}" font-family="sans-serif" text-anchor="middle" fill="#fff">${label}</text></svg>`;

export function fakeImmich(): FakeImmich {
  const assets = new Map<string, FakeAsset>();
  const albums = new Map<string, string[]>();
  const requests: FakeImmich["requests"] = [];
  const state = { failWith: null as number | null, albumRead: true };
  const inAlbum = (a: FakeAsset, ids: string[]) => ids.some((id) => albums.get(id)?.includes(a.id));
  // As Immich: a branch naming albums searches them, any other branch the user's own assets.
  const matches = (a: FakeAsset, f: Omit<FakeFilter, "takenAt" | "or">) =>
    (!f.type || f.type.in.includes(a.type)) && (f.albumIds ? inAlbum(a, f.albumIds.any) : !a.foreign);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get("x-api-key");
      requests.push({ method: req.method, path: url.pathname + url.search, key, range: req.headers.get("range") });
      if (key !== IMMICH_KEY) return Response.json({ message: "Authentication required" }, { status: 401 });
      if (url.pathname === "/api/albums" && req.method === "GET") {
        if (!state.albumRead)
          return Response.json({ message: "Missing required permission: album.read" }, { status: 403 });
        return Response.json(
          [...albums].map(([id, ids]) => {
            const days = ids.flatMap((i) => assets.get(i)?.taken_at.slice(0, 10) ?? []).sort();
            const day = (d: string | undefined) => (d ? `${d}T00:00:00.000Z` : undefined);
            return { id, albumName: `album ${id.slice(0, 4)}`, startDate: day(days[0]), endDate: day(days.at(-1)) };
          }),
        );
      }
      if (url.pathname === "/api/search/metadata" && req.method === "POST") {
        const body = (await req.json()) as { filter: FakeFilter };
        (requests.at(-1) as { body?: unknown }).body = body;
        const { takenAt, or, ...top } = body.filter;
        const named = [top, ...(or ?? [])].flatMap((f) => f.albumIds?.any ?? []);
        if (named.some((id) => !albums.has(id)))
          return Response.json({ message: "Not found or no album.read access" }, { status: 400 });
        const from = Date.parse(takenAt.gte);
        const to = Date.parse(takenAt.lt);
        const items = [...assets.values()]
          .filter((a) => Date.parse(a.taken_at) >= from && Date.parse(a.taken_at) < to)
          .filter((a) => !top.trashedAt || !a.trashed)
          .filter((a) => (or ? or.some((b) => matches(a, b)) : matches(a, top)))
          .map(raw);
        return Response.json({ assets: { items, nextCursor: null } });
      }
      const m = /^\/api\/assets\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const found = m ? assets.get(m[1] as string) : undefined;
      const a = found && (!found.foreign || inAlbum(found, [...albums.keys()])) ? found : undefined;
      if (!m || !a) return Response.json({ message: "Not found or no asset.read access" }, { status: 400 });
      const rest = m[2] ?? "";
      if (rest === "") return Response.json(raw(a));
      if (state.failWith) return new Response("fail", { status: state.failWith });
      if (rest === "/thumbnail") {
        const big = url.searchParams.get("size") === "preview";
        const k = big ? Math.min(1, 1440 / Math.max(a.width, a.height)) : 250 / Math.max(a.width, a.height);
        const body = svg(
          a,
          Math.round(a.width * k),
          Math.round(a.height * k),
          big ? `preview ${a.id.slice(0, 4)}` : "",
        );
        return new Response(body, { headers: { "content-type": "image/svg+xml", etag: `"${a.id}-${big}"` } });
      }
      if (rest === "/video/playback" && a.type === "VIDEO" && a.endless) {
        let timer: ReturnType<typeof setInterval>;
        const body = new ReadableStream({
          start(c) {
            timer = setInterval(() => c.enqueue(new Uint8Array(64)), 50);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(body, { headers: { "content-type": "video/mp4" } });
      }
      if (rest === "/video/playback" && a.type === "VIDEO") {
        const bytes = new Uint8Array(VIDEO_BYTES).map((_, i) => i % 251);
        const range = req.headers.get("range");
        const r = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        if (r) {
          const start = Number(r[1]);
          const end = r[2] ? Math.min(Number(r[2]), VIDEO_BYTES - 1) : VIDEO_BYTES - 1;
          if (start >= VIDEO_BYTES)
            return new Response(null, { status: 416, headers: { "content-range": `bytes */${VIDEO_BYTES}` } });
          return new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${end}/${VIDEO_BYTES}`,
            },
          });
        }
        return new Response(bytes, { headers: { "content-type": "video/mp4", "accept-ranges": "bytes" } });
      }
      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });
  const raw = (a: FakeAsset) => ({
    id: a.id,
    type: a.type,
    width: a.width,
    height: a.height,
    duration: a.type === "VIDEO" ? (a.duration_ms ?? 12_000) : null,
    thumbhash: `th-${a.id}`,
    updatedAt: "2026-10-20T10:00:00.000Z",
    fileCreatedAt: a.taken_at,
    isTrashed: a.trashed === true,
    exifInfo: { latitude: a.lat ?? null, longitude: a.lon ?? null, dateTimeOriginal: a.taken_at },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    assets,
    albums,
    requests,
    get albumRead() {
      return state.albumRead;
    },
    set albumRead(v) {
      state.albumRead = v;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(v) {
      state.failWith = v;
    },
    stop: () => server.stop(true),
  };
}

export interface FakeGeoPlace {
  /** Searches whose text contains this answer with the place. */
  match: string;
  lat: number;
  lon: number;
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  country?: string;
  name?: string;
}

export interface FakeGeocoder {
  url: string;
  places: FakeGeoPlace[];
  requests: { path: string; userAgent: string | null }[];
  /** Make every request fail with this status. */
  failWith: number | null;
  /** Make the next this many requests fail. */
  failNext: number;
  stop(): void;
}

/** A Photon server answering from a fixed table; the reverse route answers with the nearest place. */
export function fakeGeocoder(places: FakeGeoPlace[] = []): FakeGeocoder {
  const requests: FakeGeocoder["requests"] = [];
  const state = { failWith: null as number | null, failNext: 0 };
  const feature = ({ match: _match, lat, lon, ...properties }: FakeGeoPlace) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties,
  });
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname + url.search, userAgent: req.headers.get("user-agent") });
      if (state.failWith) return new Response("fail", { status: state.failWith });
      if (state.failNext > 0) {
        state.failNext--;
        return new Response("fail", { status: 500 });
      }
      if (url.pathname === "/api/") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const found = places.filter((p) => q.includes(p.match.toLowerCase()) || p.match.toLowerCase().includes(q));
        return Response.json({ type: "FeatureCollection", features: found.map(feature) });
      }
      if (url.pathname === "/reverse") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        const near = [...places].sort(
          (a, b) => Math.hypot(a.lat - lat, a.lon - lon) - Math.hypot(b.lat - lat, b.lon - lon),
        );
        return Response.json({ type: "FeatureCollection", features: near.slice(0, 1).map(feature) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    places,
    requests,
    get failWith() {
      return state.failWith;
    },
    set failWith(v) {
      state.failWith = v;
    },
    get failNext() {
      return state.failNext;
    },
    set failNext(v) {
      state.failNext = v;
    },
    stop: () => server.stop(true),
  };
}

const km = (a: number[], b: number[]) =>
  Math.hypot(((a[0] as number) - (b[0] as number)) * 70, ((a[1] as number) - (b[1] as number)) * 111);

export interface FakeRouters {
  carUrl: string;
  trainUrl: string;
  carRequests: string[];
  trainRequests: { from: string; to: string; at: string; userAgent: string | null }[];
  /** Make the car or the train server fail with this status. */
  carFails: number | null;
  trainFails: number | null;
  /** EVA numbers between which no journey exists, as `from>to`. */
  noJourney: Set<string>;
  stop(): void;
}

/**
 * An OSRM table with car times from straight lines at 80 km/h, and the DB journey search at 120 km/h
 * plus 20 minutes. Every answer also holds a faster journey with a bus leg, which must not count.
 */
export function fakeRouters(): FakeRouters {
  const state = {
    carRequests: [] as string[],
    trainRequests: [] as FakeRouters["trainRequests"],
    carFails: null as number | null,
    trainFails: null as number | null,
    noJourney: new Set<string>(),
  };
  const car = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.carRequests.push(url.pathname + url.search);
      if (state.carFails) return new Response("fail", { status: state.carFails });
      const coords = (url.pathname.split("/").at(-1) as string).split(";").map((c) => c.split(",").map(Number));
      const list = (name: string) => (url.searchParams.get(name) as string).split(";").map(Number);
      const durations = list("sources").map((s) =>
        list("destinations").map((d) => Math.round((km(coords[s] as number[], coords[d] as number[]) / 80) * 3600)),
      );
      return Response.json({ code: "Ok", durations });
    },
  });
  const byEva = new Map(stations.map((s) => [s.eva, [s.lon, s.lat]]));
  const train = Bun.serve({
    port: 0,
    async fetch(req) {
      const wish = ((await req.json()) as { reiseHin: { wunsch: Record<string, unknown> } }).reiseHin.wunsch;
      const eva = (v: unknown) => /L=(\d+)/.exec(String(v))?.[1] as string;
      const from = eva(wish.abgangsLocationId);
      const to = eva(wish.zielLocationId);
      const at = (wish.zeitWunsch as { reiseDatum: string }).reiseDatum;
      state.trainRequests.push({ from, to, at, userAgent: req.headers.get("user-agent") });
      if (state.trainFails) return new Response("fail", { status: state.trainFails });
      if (state.noJourney.has(`${from}>${to}`)) return Response.json({ verbindungen: [] });
      const seconds = Math.round((km(byEva.get(from) as number[], byEva.get(to) as number[]) / 120) * 3600 + 1200);
      const leg = (kurztext: string) => ({ reiseDauer: seconds, verbindungsAbschnitte: [{ kurztext }] });
      return Response.json({
        verbindungen: [
          { verbindung: { ...leg("Bus"), reiseDauer: 60 } },
          { verbindung: leg("ICE") },
          { verbindung: { ...leg("RE"), reiseDauer: seconds + 1800 } },
        ],
      });
    },
  });
  return Object.assign(state, {
    carUrl: `http://127.0.0.1:${car.port}`,
    trainUrl: `http://127.0.0.1:${train.port}`,
    stop() {
      car.stop(true);
      train.stop(true);
    },
  });
}

export interface TestApp {
  fetch: (req: Request) => Promise<Response>;
  dir: string;
  config: Config;
  store: Store;
  /** Calls the app with a path and options; `editor` calls it as the proxy's login would: on the editing host, with the identity header and the site's Origin. */
  call(path: string, init?: RequestInit & { json?: unknown; admin?: boolean; editor?: boolean }): Promise<Response>;
}

export function testApp(
  immichUrl: string,
  html: string | null = null,
  webDir?: string,
  over: {
    limits?: Partial<Config["limits"]>;
    bodyTimeoutMs?: number;
    auth?: Partial<Config["auth"]>;
    publicUrl?: string;
    editUrl?: string;
    maps?: Partial<Config["maps"]>;
    meet?: Partial<Config["meet"]>;
    mapHtml?: string;
  } = {},
): TestApp {
  const dir = mkdtempSync(join(tmpdir(), "trip-diary-test-"));
  const config: Config = {
    server: {
      port: 0,
      public_url: over.publicUrl ?? "https://trip.example.org",
      edit_url: over.editUrl ?? "https://trip-edit.example.org",
      max_body_bytes: 26214400,
    },
    data: { dir },
    web: { dir: webDir ?? join(dir, "web") },
    admin: { token: ADMIN_TOKEN },
    immich: {
      url: immichUrl,
      api_key: IMMICH_KEY,
      timeout_ms: 2000,
      body_timeout_ms: over.bodyTimeoutMs ?? 600_000,
      preview_size: 1440,
      sweep_minutes: 60,
      albums_minutes: 10,
    },
    auth: {
      editor_from_header: true,
      identity_header: IDENTITY_HEADER,
      sign_out_path: "/oauth2/sign_out",
      allowed_emails: EDITOR_EMAIL,
      ...over.auth,
    },
    maps: {
      enabled: true,
      geocoder_url: "http://127.0.0.1:9",
      geocoder_timeout_ms: 2000,
      geocoder_retry_ms: 1,
      geocode_per_minute: 60,
      writes_per_minute: 120,
      trash_days: 30,
      history_keep: 30,
      avatar_per_minute: 20,
      ...over.maps,
    },
    meet: {
      enabled: true,
      car_url: "http://127.0.0.1:9",
      car_interval_ms: 0,
      train_url: "http://127.0.0.1:9",
      train_interval_ms: 0,
      timeout_ms: 2000,
      cache_days: 30,
      cache_none_days: 1,
      max_members: 30,
      station_radius_km: 10,
      train_candidates: 10,
      departure_weekday: 6,
      departure_hour: 9,
      ...over.meet,
    },
    limits: { max_notes: 1000, max_entries: 500, avatar_bytes: 131072, avatar_px: 512, ...over.limits },
  };
  const store = new Store(openDb(join(dir, "trip.db")));
  const fetch = createApp({
    config,
    store,
    immich: new Immich(immichUrl, IMMICH_KEY, {
      timeoutMs: 2000,
      bodyTimeoutMs: config.immich.body_timeout_ms,
      previewSize: 1440,
      albumsMs: config.immich.albums_minutes * 60_000,
    }),
    geocoder: new Geocoder({
      url: config.maps.geocoder_url,
      timeoutMs: config.maps.geocoder_timeout_ms,
      retryMs: config.maps.geocoder_retry_ms,
      perMinute: config.maps.geocode_per_minute,
      userAgent: "trip-diary/test (+https://trip.example.org)",
    }),
    travel: createTravel(config, store, "trip-diary/test (+https://trip.example.org)"),
    html,
    mapHtml: over.mapHtml ?? null,
    version: "test",
  });
  return {
    fetch,
    dir,
    config,
    store,
    call(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.admin) headers.set("authorization", `Bearer ${ADMIN_TOKEN}`);
      if (init.editor) {
        headers.set(config.auth.identity_header, EDITOR_EMAIL);
        headers.set("origin", config.server.edit_url);
      }
      let body = init.body;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers.set("content-type", "application/json");
      }
      const origin = init.editor ? config.server.edit_url : config.server.public_url;
      return fetch(new Request(`${origin}${path}`, { ...init, headers, body }));
    },
  };
}

/** A point on day `day`'s sample track, `f` (0..1) of the way along it. */
export function onTrack(day: number, f: number): { lat: number; lon: number } {
  const track = (fixture.days as Day[])[day - 1]?.track as Day["track"];
  const p = track[Math.round(f * (track.length - 1))] as Day["track"][number];
  return { lat: p[0], lon: p[1] };
}

/** Creates the sample trip with its days and waypoints; returns its tokens. */
export async function seedTrip(app: TestApp, slug = "sample"): Promise<{ view: string; created: TripCreated }> {
  const res = await app.call("/api/admin/trips", {
    method: "POST",
    admin: true,
    json: {
      slug,
      title: fixture.trip.title,
      short_title: "Mittelgebirge",
      timezone: "Europe/Berlin",
      start_date: "2026-10-15",
    },
  });
  if (res.status !== 201) throw new Error(`create trip: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as TripCreated;
  for (const d of fixture.days as Day[]) {
    const { n, ...put } = d;
    const r = await app.call(`/api/admin/trips/${slug}/days/${n}`, { method: "PUT", admin: true, json: put });
    if (r.status !== 200) throw new Error(`day ${n}: ${r.status} ${await r.text()}`);
  }
  await app.call(`/api/admin/trips/${slug}/waypoints`, {
    method: "PUT",
    admin: true,
    json: fixture.waypoints as Waypoint[],
  });
  return { view: created.view.token, created };
}
