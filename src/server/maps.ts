// Maps of people and places: the page, the token API and the admin API. Routes, auth and status
// codes are specified in src/shared/api.ts.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  Entry,
  EntryAction,
  EntryCreate,
  EntryPatch,
  EntryRestore,
  EntryRev,
  EntryWritten,
  MapAdminView,
  MapCreate,
  MapCreated,
  MapInfo,
  MapPatch,
  MapShare,
  MapShareCreate,
  MapShareCreated,
  MapSummary,
  MapView,
  Place,
} from "../shared/api";
import { type AvatarLimits, avatarOut, storeAvatar } from "./avatars";
import { Budget } from "./budget";
import type { Config } from "./config";
import type { EntryContent, EntryRow, MapRow, MapShareRow, Store } from "./db";
import { GeocodeError, type Geocoder } from "./geocode";
import {
  BASE_HEADERS,
  body,
  coord,
  empty,
  escapeHtml,
  HttpError,
  int,
  json,
  MEDIA_CSP,
  only,
  optStr,
  record,
  str,
  text,
} from "./http";
import { createMeet } from "./meet";
import { composePreview, decode, type Pin, project, type Raster, SECTION } from "./preview";
import { hashToken, newToken, TOKEN_RE } from "./tokens";
import type { Travel } from "./travel";

/** The base map comes from the tile host (fetch, and images on browsers without fetch for them); the worker is same-origin. */
const MAP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const LIMITS = { title: 200, shareLabel: 100, name: 80, note: 2000, placeLabel: 40, address: 200, by: 40, places: 10 };
const COLORS = 10;
const DAY_MS = 86_400_000;
/** The pictures of link previews, in `web/static`; `scripts/map-preview.ts` renders them. */
const PREVIEW = { base: "map-base.jpg", fallback: "map-fallback.jpg", size: SECTION.size, kept: 32 };

export interface MapDeps {
  config: Config;
  store: Store;
  geocoder: Geocoder;
  travel: Travel;
  /** The built client's map.html, with the `<!--MAP-->` placeholder; null when the client is not built. */
  html: string | null;
  version: string;
  now: () => Date;
  /** True when the request carries a live editor session (the login). */
  editor: (req: Request) => boolean;
}

const collator = new Intl.Collator("de", { sensitivity: "base" });

function name(v: unknown): string {
  const s = str(v, "name", LIMITS.name).trim();
  if (!s) throw new HttpError(400, "name must not be empty");
  return s;
}

function emoji(v: unknown): string | null {
  const s = optStr(v, "emoji", 32)?.trim();
  if (!s) return null;
  const graphemes = [...new Intl.Segmenter("de", { granularity: "grapheme" }).segment(s)];
  if (graphemes.length !== 1) throw new HttpError(400, "emoji must be a single character");
  return s;
}

function color(v: unknown): number {
  const c = int(v, "color");
  if (c >= COLORS) throw new HttpError(400, `color must be below ${COLORS}`);
  return c;
}

function places(v: unknown): Place[] {
  if (!Array.isArray(v)) throw new HttpError(400, "places must be an array");
  if (v.length > LIMITS.places) throw new HttpError(400, `an entry holds at most ${LIMITS.places} places`);
  const seen = new Set<string>();
  return v.map((raw, i): Place => {
    const p = record(raw, `places[${i}]`);
    only(p, ["id", "label", "address", "lat", "lon"]);
    let id = p.id == null ? "" : str(p.id, `places[${i}].id`, 16);
    if (!/^[A-Za-z0-9_-]*$/.test(id)) throw new HttpError(400, `places[${i}].id is invalid`);
    if (seen.has(id)) throw new HttpError(400, `places[${i}].id is repeated`);
    if (!id) id = randomBytes(6).toString("base64url");
    seen.add(id);
    return {
      id,
      label: p.label == null ? "" : str(p.label, `places[${i}].label`, LIMITS.placeLabel).trim(),
      address: p.address == null ? "" : str(p.address, `places[${i}].address`, LIMITS.address).trim(),
      lat: coord(p.lat, "lat"),
      lon: coord(p.lon, "lon"),
    };
  });
}

const by = (v: unknown) => optStr(v, "by", LIMITS.by)?.trim() || null;

function entryOut(r: EntryRow): Entry {
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    color: r.color,
    note: r.note,
    places: JSON.parse(r.places) as Place[],
    created: r.created,
    updated: r.updated,
    rev: r.rev,
    by: r.updated_by,
    deleted_at: r.deleted_at,
    avatar: r.avatar,
  };
}

function mapOut(r: MapRow): MapInfo {
  return { slug: r.slug, title: r.title, settings: JSON.parse(r.settings) };
}

function settings(v: unknown): string {
  only(record(v, "settings"), []);
  return "{}";
}

export interface MapRoutes {
  /** The page of `/m/<token>`. */
  page(token: string, req: Request): Response;
  /** `/api/m/<token><rest>`. */
  api(token: string, rest: string, req: Request, url: URL): Promise<Response>;
  /** `/preview/<id>.jpg`: the picture of the map's link preview. */
  preview(id: string): Promise<Response>;
  /** `/api/admin/maps<rest>`, after the admin check. */
  admin(rest: string, req: Request, url: URL): Promise<Response>;
  /** The maps with their newest live edit link, for the editor's start page. */
  home(): { title: string; detail: string; href: string | null }[];
}

export function createMapRoutes(deps: MapDeps): MapRoutes {
  const { config, store, geocoder } = deps;
  const nowIso = () => deps.now().toISOString();
  const shareUrl = (token: string) => `${config.server.public_url}/m/${token}`;
  const clock = () => deps.now().getTime();
  const writes = new Budget(config.maps.writes_per_minute, clock);
  const uploads = new Budget(config.maps.avatar_per_minute, clock);
  const avatarLimits: AvatarLimits = { bytes: config.limits.avatar_bytes, px: config.limits.avatar_px };
  const meet = createMeet({ config, store, travel: deps.travel, now: deps.now });

  function byToken(token: string): { map: MapRow; share: MapShareRow } {
    if (!TOKEN_RE.test(token)) throw new HttpError(404, "not found");
    const s = store.mapShareByHash(hashToken(token));
    if (!s || s.revoked_at) throw new HttpError(404, "not found");
    return { map: store.mapById(s.map_id) as MapRow, share: s };
  }

  const liveShare = (map: MapRow, role: MapShareRow["role"]) =>
    store
      .mapShares(map.id)
      .filter((s) => s.role === role && !s.revoked_at)
      .at(-1);

  function view(map: MapRow, editable: boolean, purge: boolean): MapView {
    const rows = store.entries(map.id).map(entryOut);
    const handout = editable ? liveShare(map, "view") : undefined;
    return {
      map: mapOut(map),
      entries: rows
        .filter((e) => !e.deleted_at)
        .sort((a, b) => Number(!a.places.length) - Number(!b.places.length) || collator.compare(a.name, b.name)),
      editable,
      rev: map.rev,
      view_url: handout ? shareUrl(handout.token) : null,
      trash: editable
        ? rows
            .filter((e) => e.deleted_at)
            .sort((a, b) => (a.deleted_at as string).localeCompare(b.deleted_at as string))
            .reverse()
        : [],
      can_purge: editable && purge,
      meet: meet.state(map),
      meet_enabled: config.meet.enabled,
    };
  }

  const livePlaces = (map: MapRow) =>
    store
      .entries(map.id)
      .filter((e) => !e.deleted_at)
      .map((e) => ({ entry: e, places: JSON.parse(e.places) as Place[] }));

  /** What a link preview shows: the live counts, and the picture under an id that is no token. */
  function openGraph(map: MapRow): string {
    const live = livePlaces(map);
    const places = live.reduce((s, e) => s + e.places.length, 0);
    const shown = live.some((e) => e.places.some((p) => project(p.lat, p.lon)));
    const image = shown
      ? `${config.server.public_url}/preview/${map.preview_id}.jpg?v=${map.rev}`
      : `${config.server.public_url}/assets/${PREVIEW.fallback}`;
    const tags = {
      "og:type": "website",
      "og:title": map.title,
      "og:description": `${live.length} ${live.length === 1 ? "Eintrag" : "Einträge"} · ${places} ${places === 1 ? "Ort" : "Orte"}`,
      "og:image": image,
      "og:image:secure_url": image,
      "og:image:type": "image/jpeg",
      "og:image:width": String(PREVIEW.size),
      "og:image:height": String(PREVIEW.size),
      "og:image:alt": "Eine Landkarte von Mitteleuropa mit bunten Stecknadeln",
    };
    return Object.entries(tags)
      .map(([k, v]) => `<meta property="${k}" content="${escapeHtml(v)}">`)
      .join("\n");
  }

  // ---- link preview picture

  /** The base map's pixels, decoded once. */
  let base: Promise<Raster> | null = null;
  const baseMap = () => {
    base ??= Bun.file(join(config.web.dir, "assets", PREVIEW.base))
      .bytes()
      .then((b) => decode(new Bun.Image(b)))
      .catch((e) => {
        base = null;
        throw e;
      });
    return base;
  };
  /** The composed bytes of the newest revision asked for, by map. */
  const composed = new Map<number, { rev: number; bytes: Uint8Array }>();
  const composing = new Map<string, Promise<Uint8Array>>();
  /** Compositions run one after the other, so a burst holds the memory of one. */
  let turn: Promise<unknown> = Promise.resolve();

  async function compose(mapId: number): Promise<{ rev: number; bytes: Uint8Array }> {
    const map = store.mapById(mapId);
    if (!map) throw new HttpError(404, "not found");
    const pins: Pin[] = livePlaces(map).flatMap(({ entry, places }) =>
      places.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        color: entry.color,
        avatar: entry.avatar ? (store.avatar(map.id, entry.avatar)?.bytes ?? null) : null,
      })),
    );
    return { rev: map.rev, bytes: await composePreview(await baseMap(), pins) };
  }

  function preview(map: MapRow): Promise<Uint8Array> {
    const kept = composed.get(map.id);
    if (kept?.rev === map.rev) return Promise.resolve(kept.bytes);
    const key = `${map.id}:${map.rev}`;
    let job = composing.get(key);
    if (!job) {
      const run = turn.then(() => compose(map.id));
      turn = run.catch(() => undefined);
      job = run
        .then((made) => {
          composed.delete(map.id);
          composed.set(map.id, made);
          for (const old of [...composed.keys()].slice(0, Math.max(0, composed.size - PREVIEW.kept)))
            composed.delete(old);
          return made.bytes;
        })
        .finally(() => composing.delete(key));
      composing.set(key, job);
    }
    return job;
  }

  async function previewOut(id: string): Promise<Response> {
    const map = /^[0-9a-f]{32}$/.test(id) ? store.mapByPreviewId(id) : null;
    if (!map) throw new HttpError(404, "not found");
    const headers = { ...BASE_HEADERS, ...MEDIA_CSP, "cache-control": "public, max-age=3600" };
    try {
      return new Response((await preview(map)) as Uint8Array<ArrayBuffer>, {
        headers: { ...headers, "content-type": "image/jpeg" },
      });
    } catch {
      const generic = Bun.file(join(config.web.dir, "assets", PREVIEW.fallback));
      if (!(await generic.exists())) throw new HttpError(404, "not found");
      return new Response(generic, { headers: { ...headers, "content-type": "image/jpeg" } });
    }
  }

  const etag = (map: MapRow, role: string, kind: string, purge: boolean) =>
    `W/"${kind}-${deps.version}-${map.rev}-${role}${purge ? "-p" : ""}"`;
  const canPurge = (share: MapShareRow, req: Request) => share.role === "edit" && deps.editor(req);

  function page(token: string, req: Request): Response {
    const { map, share } = byToken(token);
    if (!deps.html) return text("client not built", 503);
    const purge = canPurge(share, req);
    const tag = etag(map, share.role, "m", purge);
    if (req.headers.get("if-none-match") === tag) return empty(304, { etag: tag });
    const data = JSON.stringify(view(map, share.role === "edit", purge)).replace(/</g, "\\u003c");
    const html = deps.html
      .replace("<!--MAP-->", () => data)
      .replace("<!--OG-->", () => openGraph(map))
      .replace("<!--TITLE-->", () => escapeHtml(map.title));
    return text(html, 200, "text/html; charset=utf-8", {
      "content-security-policy": MAP_CSP,
      "cache-control": "no-cache",
      etag: tag,
    });
  }

  // ---- geocoding

  async function geocode(budget: string, url: URL): Promise<Response> {
    const q = url.searchParams.get("q");
    const lat = url.searchParams.get("lat");
    const lon = url.searchParams.get("lon");
    const point =
      lat != null && lon != null ? { lat: coord(Number(lat), "lat"), lon: coord(Number(lon), "lon") } : null;
    try {
      if (q == null) {
        if (!point) throw new HttpError(400, "give q, or lat and lon");
        return json(await geocoder.reverse(budget, point.lat, point.lon));
      }
      const text = q.trim();
      if (text.length < 3) throw new HttpError(400, "q must have at least 3 characters");
      if (text.length > LIMITS.address) throw new HttpError(400, `q is longer than ${LIMITS.address} characters`);
      return json(await geocoder.search(budget, text, point ?? undefined));
    } catch (e) {
      if (e instanceof GeocodeError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // ---- entries

  function entryRow(map: MapRow, idRaw: string): EntryRow {
    const row = /^\d{1,12}$/.test(idRaw) ? store.entryById(map.id, Number(idRaw)) : null;
    if (!row) throw new HttpError(404, "entry not found");
    return row;
  }

  const content = (r: EntryRow): EntryContent => ({
    name: r.name,
    emoji: r.emoji,
    color: r.color,
    note: r.note,
    places: r.places,
    updated: r.updated,
    updated_by: r.updated_by,
    deleted_at: r.deleted_at,
    avatar: r.avatar,
  });

  /** Saves the entry's new content, keeps the state before it in the history and bumps the map. */
  function write(row: EntryRow, next: EntryContent, action: EntryAction): EntryWritten {
    return store.tx(() => {
      const rev = store.insertEntryRev(
        {
          entry_id: row.id,
          at: next.updated,
          by: next.updated_by,
          action,
          snapshot: JSON.stringify(entryOut(row)),
        },
        config.maps.history_keep,
      );
      const saved = store.updateEntry(row.id, next);
      store.bumpMap(row.map_id);
      return { ...entryOut(saved), undo_rev: rev.id };
    });
  }

  async function createEntry(map: MapRow, req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ["name", "emoji", "color", "note", "places", "by", "client_id"]);
    const c = b as unknown as EntryCreate;
    const clientId = c.client_id == null ? null : str(c.client_id, "client_id", 64) || null;
    if (clientId) {
      const seen = store.entryByClientId(map.id, clientId);
      if (seen?.deleted_at) {
        const next = { ...content(seen), updated: nowIso(), deleted_at: null };
        return json(write(seen, next, "restore"), 200);
      }
      if (seen) return json(entryOut(seen), 200);
    }
    const t = nowIso();
    const fields = {
      name: name(c.name),
      emoji: emoji(c.emoji),
      note: c.note == null ? "" : str(c.note, "note", LIMITS.note),
      places: JSON.stringify(places(c.places ?? [])),
      updated_by: by(c.by),
    };
    const explicit = c.color == null ? null : color(c.color);
    const row = store.tx(() => {
      if (store.entryCount(map.id) >= config.limits.max_entries)
        throw new HttpError(409, `the map has reached its limit of ${config.limits.max_entries} entries`);
      const last = store.lastEntryColor(map.id);
      const r = store.insertEntry({
        ...fields,
        map_id: map.id,
        color: explicit ?? (last == null ? 0 : (last + 1) % COLORS),
        created: t,
        updated: t,
        client_id: clientId,
      });
      store.insertEntryRev(
        { entry_id: r.id, at: t, by: r.updated_by, action: "create", snapshot: JSON.stringify(entryOut(r)) },
        config.maps.history_keep,
      );
      store.bumpMap(map.id);
      return r;
    });
    return json(entryOut(row), 201);
  }

  async function patchEntry(map: MapRow, id: string, req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ["name", "emoji", "color", "note", "places", "avatar", "by"]);
    const p = b as EntryPatch;
    const row = entryRow(map, id);
    const ifMatch = req.headers.get("if-match");
    if (ifMatch != null && ifMatch.replace(/"/g, "") !== String(row.rev))
      throw new HttpError(412, "the entry changed since it was read", { entry: entryOut(row) });
    // The latest action wins: a save onto a deleted entry brings it back.
    const next = { ...content(row), updated: nowIso(), updated_by: by(p.by), deleted_at: null };
    if (p.name !== undefined) next.name = name(p.name);
    if (p.emoji !== undefined) next.emoji = emoji(p.emoji);
    if (p.color !== undefined) next.color = color(p.color);
    if (p.note !== undefined) next.note = str(p.note, "note", LIMITS.note);
    if (p.places !== undefined) next.places = JSON.stringify(places(p.places));
    if (p.avatar !== undefined) {
      if (p.avatar !== null) throw new HttpError(400, "avatar can only be cleared here");
      next.avatar = null;
    }
    return json({ ...write(row, next, "update"), revived: row.deleted_at != null });
  }

  function deleteEntry(map: MapRow, id: string, url: URL): Response {
    const row = entryRow(map, id);
    if (row.deleted_at) throw new HttpError(404, "entry not found");
    const t = nowIso();
    const who = by(url.searchParams.get("by"));
    return json(write(row, { ...content(row), updated: t, updated_by: who, deleted_at: t }, "delete"));
  }

  async function restoreEntry(map: MapRow, id: string, req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ["rev", "by"]);
    const r = b as EntryRestore;
    const row = entryRow(map, id);
    const next = { ...content(row), updated: nowIso(), updated_by: by(r.by), deleted_at: null };
    if (r.rev == null) {
      if (!row.deleted_at) throw new HttpError(409, "the entry is not deleted");
    } else {
      const old = store.entryRev(row.id, int(r.rev, "rev"));
      if (!old) throw new HttpError(404, "history state not found");
      const s = JSON.parse(old.snapshot) as Entry;
      Object.assign(next, {
        name: s.name,
        emoji: s.emoji,
        color: s.color,
        note: s.note,
        places: JSON.stringify(s.places),
        avatar: s.avatar ?? null,
      });
    }
    return json(write(row, next, "restore"));
  }

  function purgeEntry(map: MapRow, id: string, purge: boolean): Response {
    if (!purge) throw new HttpError(403, "deleting for good needs the login");
    const row = entryRow(map, id);
    if (!row.deleted_at) throw new HttpError(409, "the entry is not deleted");
    store.purgeEntry(map.id, row.id);
    return empty(204);
  }

  function history(map: MapRow, id: string): Response {
    const row = entryRow(map, id);
    const out: EntryRev[] = store.entryRevs(row.id).map((r) => ({
      id: r.id,
      at: r.at,
      by: r.by,
      action: r.action,
      snapshot: JSON.parse(r.snapshot) as Entry,
    }));
    return json(out);
  }

  async function editRoutes(map: MapRow, rest: string, req: Request, url: URL, purge: boolean): Promise<Response> {
    if (!config.meet.enabled && rest.startsWith("/meet")) throw new HttpError(404, "not found");
    const method = req.method;
    let m: RegExpExecArray | null;
    if (rest === "/entries" && method === "POST") return createEntry(map, req);
    if ((m = /^\/entries\/([^/]+)$/.exec(rest))) {
      if (method === "GET") return json(entryOut(entryRow(map, m[1] as string)));
      if (method === "PATCH") return patchEntry(map, m[1] as string, req);
      if (method === "DELETE") return deleteEntry(map, m[1] as string, url);
    }
    if ((m = /^\/entries\/([^/]+)\/restore$/.exec(rest)) && method === "POST")
      return restoreEntry(map, m[1] as string, req);
    if ((m = /^\/entries\/([^/]+)\/history$/.exec(rest)) && method === "GET") return history(map, m[1] as string);
    if ((m = /^\/entries\/([^/]+)\/purge$/.exec(rest)) && method === "DELETE")
      return purgeEntry(map, m[1] as string, purge);
    if ((m = /^\/entries\/([^/]+)\/avatar$/.exec(rest))) {
      if (method === "PUT") return putAvatar(map, m[1] as string, req);
      if (method === "DELETE") return setAvatar(entryRow(map, m[1] as string), null, url.searchParams.get("by"));
    }
    if ((m = /^\/meet\/members\/([^/]+)$/.exec(rest))) {
      const row = entryRow(map, m[1] as string);
      if (method === "PUT") return json(meet.putMember(map, row, await body(req)));
      if (method === "DELETE") return json(meet.deleteMember(map, row));
    }
    if (rest === "/meet/compute" && method === "POST") return json(meet.compute(map), 202);
    throw new HttpError(404, "not found");
  }

  function setAvatar(row: EntryRow, avatar: string | null, who: string | null): Response {
    return json(write(row, { ...content(row), updated: nowIso(), updated_by: by(who), avatar }, "update"));
  }

  async function putAvatar(map: MapRow, id: string, req: Request): Promise<Response> {
    const row = entryRow(map, id);
    if (Number(req.headers.get("content-length")) > avatarLimits.bytes)
      throw new HttpError(413, `a picture may have ${avatarLimits.bytes} bytes`);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const avatar = storeAvatar(store, map.id, bytes, avatarLimits, nowIso());
    return setAvatar(row, avatar, new URL(req.url).searchParams.get("by"));
  }

  /** What either token, and the admin, may read beside the view. */
  function reads(map: MapRow, rest: string): Response | null {
    if (rest === "/meet" && !config.meet.enabled) throw new HttpError(404, "not found");
    if (rest === "/meet") return json(meet.state(map));
    const a = /^\/avatar\/([0-9a-f]{32})$/.exec(rest);
    return a ? avatarOut(store, map.id, a[1] as string) : null;
  }

  async function api(token: string, rest: string, req: Request, url: URL): Promise<Response> {
    const { map, share } = byToken(token);
    if (rest === "" && req.method === "GET") {
      const purge = canPurge(share, req);
      const tag = etag(map, share.role, "a", purge);
      if (req.headers.get("if-none-match") === tag) return empty(304, { etag: tag });
      return json(view(map, share.role === "edit", purge), 200, { etag: tag, "cache-control": "no-cache" });
    }
    if (rest === "/geocode" && req.method === "GET") return geocode(`share-${share.id}`, url);
    const read = req.method === "GET" ? reads(map, rest) : null;
    if (read) return read;
    if (share.role !== "edit") throw new HttpError(403, "this link is read-only");
    if (req.method !== "GET" && !writes.take(token)) throw new HttpError(429, "too many writes, wait a minute");
    if (req.method === "PUT" && rest.endsWith("/avatar") && !uploads.take(token))
      throw new HttpError(429, "too many uploads, wait a minute");
    return editRoutes(map, rest, req, url, canPurge(share, req));
  }

  // ---- admin

  function shareOut(s: MapShareRow): MapShare {
    return {
      id: s.id,
      role: s.role,
      label: s.label,
      created: s.created,
      revoked_at: s.revoked_at,
      url: shareUrl(s.token),
    };
  }

  function newShare(map: MapRow, role: MapShareRow["role"], label: string): MapShareCreated {
    const token = newToken();
    const row = store.insertMapShare({
      map_id: map.id,
      role,
      label,
      token_hash: hashToken(token),
      token,
      created: nowIso(),
    });
    store.bumpMap(map.id);
    return { ...shareOut(row), token };
  }

  async function createMap(req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ["slug", "title", "settings"]);
    const c = b as unknown as MapCreate;
    const slug = str(c.slug, "slug", 40);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      throw new HttpError(400, "slug must be lowercase letters, digits and dashes");
    if (store.mapBySlug(slug)) throw new HttpError(409, "slug is taken");
    const title = str(c.title, "title", LIMITS.title);
    const set = c.settings == null ? "{}" : settings(c.settings);
    const created = store.tx((): MapCreated => {
      const map = store.insertMap({ slug, title, created: nowIso(), settings: set });
      return { map: mapOut(map), view: newShare(map, "view", "lesen"), edit: newShare(map, "edit", "schreiben") };
    });
    return json(created, 201);
  }

  async function admin(rest: string, req: Request, url: URL): Promise<Response> {
    const method = req.method;
    if (rest === "") {
      if (method === "GET") {
        const out: MapSummary[] = store.maps().map((m) => ({
          slug: m.slug,
          title: m.title,
          entries: store.liveEntryCount(m.id),
          rev: m.rev,
        }));
        return json(out);
      }
      if (method === "POST") return createMap(req);
    }
    const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(rest);
    if (!m) throw new HttpError(404, "not found");
    const map = store.mapBySlug(m[1] as string);
    if (!map) throw new HttpError(404, "map not found");
    const sub = m[2] ?? "";
    if (sub === "") {
      if (method === "GET") {
        const v: MapAdminView = { ...view(map, true, true), shares: store.mapShares(map.id).map(shareOut) };
        return json(v);
      }
      if (method === "PATCH") {
        const b = await body(req);
        only(b, ["title", "settings"]);
        const p = b as MapPatch;
        return json(
          mapOut(
            store.updateMap(map.id, {
              title: p.title === undefined ? map.title : str(p.title, "title", LIMITS.title),
              settings: p.settings === undefined ? map.settings : settings(p.settings),
            }),
          ),
        );
      }
      if (method === "DELETE") {
        store.deleteMap(map.id);
        return empty();
      }
    }
    if (sub === "/geocode" && method === "GET") return geocode(`admin-${map.id}`, url);
    const read = method === "GET" ? reads(map, sub) : null;
    if (read) return read;
    if (sub === "/shares") {
      if (method === "GET") return json(store.mapShares(map.id).map(shareOut));
      if (method === "POST") {
        const b = await body(req);
        only(b, ["role", "label"]);
        const s = b as unknown as MapShareCreate;
        if (s.role !== "view" && s.role !== "edit") throw new HttpError(400, "role must be view or edit");
        return json(newShare(map, s.role, str(s.label, "label", LIMITS.shareLabel)), 201);
      }
    }
    const share = /^\/shares\/(\d+)$/.exec(sub);
    if (share && method === "DELETE") {
      if (!store.revokeMapShare(map.id, Number(share[1]), nowIso()))
        throw new HttpError(404, "share not found or already revoked");
      store.rotatePreviewId(map.id);
      store.bumpMap(map.id);
      return empty();
    }
    return editRoutes(map, sub, req, url, true);
  }

  function home() {
    return [...store.maps()].reverse().map((m) => {
      const n = store.liveEntryCount(m.id);
      const link = liveShare(m, "edit");
      return {
        title: m.title,
        detail: `${n} ${n === 1 ? "Eintrag" : "Einträge"}`,
        href: link ? `/m/${link.token}` : null,
      };
    });
  }

  return { page, api, admin, home, preview: previewOut };
}

/** Removes entries past the trash period for good; returns how many. */
export const purgeEntries = (store: Store, days: number, now: Date) =>
  store.purgeTrash(new Date(now.getTime() - days * DAY_MS).toISOString());
