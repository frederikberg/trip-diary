// HTTP routing and handlers. Routes, auth and status codes are specified in src/shared/api.ts.
import { join } from "node:path";
import type {
  Day,
  DayPut,
  MediaAttach,
  MediaPatch,
  MediaSize,
  NoteCreate,
  NotePatch,
  ShareCreate,
  ShareCreated,
  Suggestion,
  TripAdminView,
  TripCreate,
  TripCreated,
  TripPatch,
  TripSummary,
  Waypoint,
} from "../shared/api";
import { isoInZone, localDate, parseIso, zonedInstant } from "../shared/time";
import type { Config } from "./config";
import type { MediaRow, NoteRow, ShareRow, Store, TripRow } from "./db";
import type { Geocoder } from "./geocode";
import { FORM_CSP, HOME_CSP, homePage, type NewTripForm, newTripPage, type SettingsForm, settingsPage } from "./home";
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
  obj,
  only,
  optStr,
  record,
  str,
  text,
} from "./http";
import { type AssetInfo, type Immich, ImmichError } from "./immich";
import { createMapRoutes } from "./maps";
import { haversineM, positionAt } from "./ordering";
import { hashToken, newToken, sameSecret, TOKEN_RE } from "./tokens";
import type { Travel } from "./travel";
import { buildView, mediaOut, noteOut, parseNoteKey, privacyOf, shareOut, tripOut, type ViewScope } from "./view";

export interface Deps {
  config: Config;
  store: Store;
  immich: Immich;
  geocoder: Geocoder;
  travel: Travel;
  /** The built client's index.html, with the `<!--TRIP-->` placeholder; null when the client is not built. */
  html: string | null;
  /** The built client's map.html, with the `<!--MAP-->` placeholder; null when the client is not built. */
  mapHtml: string | null;
  version: string;
  /** Clock, replaceable in tests. */
  now?: () => Date;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://*.tile.opentopomap.org https://tile.opentopomap.org",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#e5e0d5"/><path d="M1.2 2.1l.6-.7.5.5.4-.3.7.5z" fill="#c9c1b0"/></svg>`;

const LIMITS = { title: 200, text: 100_000, caption: 1000, label: 100 };

// ---------------------------------------------------------------- validation

function iso(v: unknown, field: string): string {
  if (!Number.isFinite(parseIso(v))) throw new HttpError(400, `${field} must be an ISO-8601 time with offset`);
  return v as string;
}

function date(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return v;
}

function zone(v: unknown): string {
  const tz = str(v, "timezone", 64);
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new HttpError(400, "timezone is not an IANA zone");
  }
  return tz;
}

const IMMICH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function immichId(v: unknown, field: string): string {
  if (typeof v !== "string" || !IMMICH_ID.test(v)) throw new HttpError(400, `${field} must be an Immich asset id`);
  return v.toLowerCase();
}

function dayOffset(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 99)
    throw new HttpError(400, "day_offset must be an integer from -99 to 99");
  return v;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The zones the editor's forms suggest. */
const ZONES = Intl.supportedValuesOf("timeZone");

/** Merges a partial `TripPrivacy` into the stored one. */
function privacyJson(v: unknown, current: string): string {
  if (v == null) return current;
  const p = record(v, "privacy");
  only(p, ["hide_camps", "delay_hours"]);
  const out = JSON.parse(current) as Record<string, unknown>;
  if (p.hide_camps !== undefined) {
    if (typeof p.hide_camps !== "boolean") throw new HttpError(400, "privacy.hide_camps must be true or false");
    out.hide_camps = p.hide_camps;
  }
  if (p.delay_hours !== undefined) out.delay_hours = int(p.delay_hours, "privacy.delay_hours");
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- the app

interface TripCtx {
  trip: TripRow;
  /** Admin routes allow the admin-only fields. */
  admin: boolean;
  scope: ViewScope;
}

export function createApp(deps: Deps): (req: Request) => Promise<Response> {
  const { config, store, immich } = deps;
  const now = deps.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const maps = createMapRoutes({
    config,
    store,
    geocoder: deps.geocoder,
    travel: deps.travel,
    html: deps.mapHtml,
    version: deps.version,
    now,
    editor: (req) => editorOf(req),
  });

  // ---- auth

  function viewShare(token: string): { trip: TripRow; share: ShareRow } {
    if (!TOKEN_RE.test(token)) throw new HttpError(404, "not found");
    const s = store.shareByHash(hashToken(token));
    if (s?.role !== "view" || s.revoked_at) throw new HttpError(404, "not found");
    return { trip: store.tripById(s.trip_id) as TripRow, share: s };
  }

  /** Addresses that may edit: `auth.allowed_emails`, compared without case. */
  const editors = new Set(
    config.auth.allowed_emails
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const editHost = new URL(config.server.edit_url).host;
  const onEditHost = (req: Request) => new URL(req.url).host === editHost;

  /**
   * Whether the request is the editor's: it arrived on the editing host, the reverse proxy put the
   * address it logged in into `auth.identity_header`, and that address may edit. The proxy blanks
   * the header on every other host and route, so a request to the public host never qualifies.
   */
  function editorOf(req: Request): boolean {
    if (!config.auth.editor_from_header || !onEditHost(req)) return false;
    const email = req.headers.get(config.auth.identity_header)?.trim().toLowerCase();
    return !!email && editors.has(email);
  }

  /** A write must come from the editor and from this site's own pages. */
  function requireEditor(req: Request): void {
    if (!editorOf(req)) throw new HttpError(403, "this link is read-only");
    if (req.headers.get("origin") !== config.server.edit_url) throw new HttpError(403, "cross-origin request");
  }

  /**
   * The editor's pages live on the editing host, behind the proxy's login: anyone else gets 404
   * while editing is off, 403 there, and from any other host a redirect to the same page there.
   */
  function editorPage(req: Request, path: string): Response | null {
    if (editorOf(req)) return null;
    if (!config.auth.editor_from_header) throw new HttpError(404, "not found");
    if (onEditHost(req)) throw new HttpError(403, "this account may not edit");
    return new Response(null, {
      status: 302,
      headers: { ...BASE_HEADERS, location: `${config.server.edit_url}${path}`, "cache-control": "no-store" },
    });
  }

  /**
   * The view token the editor opens a trip with: its editor view token while it has one, so a draft
   * kept under that token stays visible, else the newest live link. `without` leaves one share out.
   */
  function editorToken(trip: TripRow, without?: number): string | null {
    const live = store.shares(trip.id).filter((s) => s.role === "view" && !s.revoked_at && s.token && s.id !== without);
    return (live.filter((s) => s.editor).at(-1) ?? live.at(-1))?.token ?? null;
  }

  function tripDetail(trip: TripRow): string {
    const notes = store.noteCount(trip.id);
    const days = store.days(trip.id).length;
    return `${days} ${days === 1 ? "Tag" : "Tage"} · ${notes} ${notes === 1 ? "Notiz" : "Notizen"}`;
  }

  function home(req: Request): Response {
    const away = editorPage(req, "/");
    if (away) return away;
    const list = [...store.trips()].reverse().map((t) => {
      const token = editorToken(t);
      return {
        title: t.title,
        detail: tripDetail(t),
        href: token ? `/${token}` : null,
        settings: `/trips/${t.slug}`,
      };
    });
    return text(
      homePage(list, config.maps.enabled ? maps.home() : [], config.auth.sign_out_path),
      200,
      "text/html; charset=utf-8",
      {
        "content-security-policy": HOME_CSP,
        "cache-control": "no-store",
      },
    );
  }

  function scopeFor(trip: TripRow, base: string, editable: boolean): ViewScope {
    return {
      base,
      editable,
      ids: editable,
      shareUrl: editable ? handoutUrl(trip) : null,
      signOutPath: editable ? config.auth.sign_out_path : null,
    };
  }

  /** The read link editors hand out: the newest live view share that is not an editor's. */
  function handoutUrl(trip: TripRow): string | null {
    const s = store
      .shares(trip.id)
      .filter((x) => x.role === "view" && !x.editor && !x.revoked_at && x.token)
      .at(-1);
    return s ? `${config.server.public_url}/${s.token}` : null;
  }

  function requireAdmin(req: Request): void {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m || !sameSecret(m[1] as string, config.admin.token)) throw new HttpError(401, "admin token missing or wrong");
  }

  function tripOrThrow(slug: string): TripRow {
    const t = store.tripBySlug(slug);
    if (!t) throw new HttpError(404, "trip not found");
    return t;
  }

  // ---- notes

  function noteRow(trip: TripRow, key: string): NoteRow {
    const k = parseNoteKey(key);
    const row = !k ? null : k.kind === "note" ? store.noteByNumber(trip.id, k.number) : store.noteByDay(trip.id, k.day);
    if (!row) throw new HttpError(404, "note not found");
    return row;
  }

  function renderNote(ctx: TripCtx, row: NoteRow) {
    const fresh = store.tripById(ctx.trip.id) as TripRow;
    const { prepared } = buildView(store, fresh, ctx.scope, now().getTime());
    return noteOut(row, store.mediaOfNote(row.id), prepared, ctx.scope);
  }

  async function asset(id: string): Promise<AssetInfo> {
    try {
      return await immich.asset(id);
    } catch (e) {
      if (e instanceof ImmichError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  function insertImmichMedia(
    trip: TripRow,
    note: NoteRow,
    a: AssetInfo,
    caption: string | null,
    position?: number,
  ): MediaRow {
    const existing = store.mediaOfNote(note.id);
    if (existing.some((m) => m.immich_id === a.id)) throw new HttpError(409, "asset is already attached to this note");
    const row = store.insertMedia({
      trip_id: trip.id,
      note_id: note.id,
      position: existing.length,
      immich_id: a.id,
      type: a.type,
      caption,
      taken_at: a.taken_at,
      lat: a.lat,
      lon: a.lon,
      width: a.width,
      height: a.height,
      duration_ms: a.duration_ms,
      v: a.v,
      created: nowIso(),
    });
    place(existing, row, position);
    return row;
  }

  /** Puts `row` at `position` among `existing` (default: last) and renumbers. */
  function place(existing: MediaRow[], row: MediaRow, position?: number): void {
    const ids = existing.map((m) => m.id).filter((id) => id !== row.id);
    const at = position == null ? ids.length : Math.max(0, Math.min(ids.length, position));
    ids.splice(at, 0, row.id);
    store.setOrder(ids);
  }

  async function createNote(ctx: TripCtx, req: Request): Promise<Response> {
    const b = await body(req);
    only(
      b,
      ctx.admin
        ? ["lat", "lon", "from_asset", "title", "text", "at", "number", "created", "extra", "client_id"]
        : ["lat", "lon", "title", "text", "at", "created", "client_id"],
    );
    const c = b as NoteCreate;
    const { trip } = ctx;
    const clientId = c.client_id == null ? null : str(c.client_id, "client_id", 64);
    if (clientId) {
      const seen = store.noteByClientId(trip.id, clientId);
      if (seen) return json(renderNote(ctx, seen), 200);
    }
    let lat: number | null;
    let lon: number | null;
    let a: AssetInfo | null = null;
    if (c.from_asset != null) {
      if (c.lat != null || c.lon != null) throw new HttpError(400, "give either lat/lon or from_asset");
      a = await asset(immichId(c.from_asset, "from_asset"));
      if (a.lat != null && a.lon != null) {
        lat = coord(a.lat, "lat");
        lon = coord(a.lon, "lon");
      } else {
        const t = a.taken_at ? Date.parse(a.taken_at) : Number.NaN;
        const { prepared } = buildView(store, trip, ctx.scope, now().getTime());
        const pos = Number.isFinite(t) ? positionAt(t, prepared) : null;
        if (!pos) throw new HttpError(400, "the asset has no GPS position and its time is outside the recorded tracks");
        lat = coord(pos.lat, "lat");
        lon = coord(pos.lon, "lon");
      }
    } else if (c.lat === null && c.lon === null) {
      lat = null;
      lon = null;
    } else {
      lat = coord(c.lat, "lat");
      lon = coord(c.lon, "lon");
    }
    const created = c.created != null ? iso(c.created, "created") : nowIso();
    if (!ctx.admin && c.created != null) {
      const t = Date.parse(created);
      if (t > now().getTime() + 60_000 || t < now().getTime() - 7 * 86_400_000)
        throw new HttpError(400, "created must lie within the last 7 days");
    }
    const row = store.tx(() => {
      if (store.noteCount(trip.id) >= config.limits.max_notes)
        throw new HttpError(409, `the trip has reached its limit of ${config.limits.max_notes} notes`);
      let number = store.maxNumber(trip.id) + 1;
      if (c.number != null) {
        number = int(c.number, "number", 1);
        if (store.noteByNumber(trip.id, number)) throw new HttpError(409, `note ${number} exists`);
      }
      const n = store.insertNote({
        trip_id: trip.id,
        kind: "note",
        number,
        day_n: null,
        lat,
        lon,
        title: c.title == null ? "" : str(c.title, "title", LIMITS.title),
        text: c.text == null ? "" : str(c.text, "text", LIMITS.text),
        created,
        updated: nowIso(),
        // A note without a place stands by its time alone.
        at: c.at != null ? iso(c.at, "at") : lat == null ? created : null,
        extra: JSON.stringify(c.extra == null ? {} : record(c.extra, "extra")),
        client_id: clientId,
      });
      if (a) insertImmichMedia(trip, n, a, null);
      store.bump(trip.id);
      return n;
    });
    return json(renderNote(ctx, row), 201);
  }

  async function patchNote(ctx: TripCtx, key: string, req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ctx.admin ? ["lat", "lon", "title", "text", "at", "extra"] : ["lat", "lon", "title", "text", "at"]);
    const p = b as NotePatch;
    const row = noteRow(ctx.trip, key);
    const ifMatch = req.headers.get("if-match");
    if (ifMatch != null && ifMatch.replace(/"/g, "") !== String(row.rev))
      throw new HttpError(412, "the note changed since it was read", { note: renderNote(ctx, row) });
    const next = { ...row };
    if (p.at !== undefined) next.at = p.at == null ? null : iso(p.at, "at");
    if (p.lat !== undefined || p.lon !== undefined) {
      if (row.kind === "day") throw new HttpError(400, "a day-end note stands at its day's end");
      if (p.lat === null && p.lon === null) {
        next.lat = null;
        next.lon = null;
        // Taking the place away keeps the note where it stood in the timeline.
        if (p.at === undefined && next.at == null) next.at = renderNote(ctx, row).anchor.t;
      } else {
        next.lat = coord(p.lat, "lat");
        next.lon = coord(p.lon, "lon");
      }
    }
    if (row.kind === "note" && next.lat == null && next.at == null)
      throw new HttpError(400, "a note without a place needs a time (at)");
    if (p.title !== undefined) next.title = str(p.title, "title", LIMITS.title);
    if (p.text !== undefined) next.text = str(p.text, "text", LIMITS.text);
    if (p.extra !== undefined) next.extra = JSON.stringify(record(p.extra, "extra"));
    next.updated = nowIso();
    const saved = store.tx(() => {
      const r = store.updateNote(next);
      store.bump(ctx.trip.id);
      return r;
    });
    return json(renderNote(ctx, saved));
  }

  function deleteNote(ctx: TripCtx, key: string): Response {
    const row = noteRow(ctx.trip, key);
    if (row.kind === "day") throw new HttpError(409, "day-end notes go with their day");
    store.tx(() => {
      store.deleteNote(row.id);
      store.bump(ctx.trip.id);
    });
    return empty();
  }

  // ---- media

  async function addMedia(ctx: TripCtx, key: string, req: Request): Promise<Response> {
    const note = noteRow(ctx.trip, key);
    const b = await body(req);
    only(b, ["immich_id", "caption", "position"]);
    const m = b as unknown as MediaAttach;
    const a = await asset(immichId(m.immich_id, "immich_id"));
    const caption = optStr(m.caption, "caption", LIMITS.caption);
    const position = m.position == null ? undefined : int(m.position, "position");
    const row = store.tx(() => {
      const r = insertImmichMedia(ctx.trip, note, a, caption, position);
      store.touchNote(note.id, nowIso());
      store.bump(ctx.trip.id);
      return r;
    });
    return json(mediaOut(store.mediaById(ctx.trip.id, row.id) as MediaRow, ctx.scope), 201);
  }

  function mediaOfNoteOrThrow(ctx: TripCtx, key: string, id: string): { note: NoteRow; media: MediaRow } {
    const note = noteRow(ctx.trip, key);
    const media = /^\d+$/.test(id) ? store.mediaById(ctx.trip.id, Number(id)) : null;
    if (!media || media.note_id !== note.id) throw new HttpError(404, "media not found");
    return { note, media };
  }

  async function patchMedia(ctx: TripCtx, key: string, id: string, req: Request): Promise<Response> {
    const { note, media } = mediaOfNoteOrThrow(ctx, key, id);
    const b = await body(req);
    only(b, ["caption", "position"]);
    const p = b as MediaPatch;
    const caption = p.caption === undefined ? undefined : optStr(p.caption, "caption", LIMITS.caption);
    const position = p.position === undefined ? undefined : int(p.position, "position");
    store.tx(() => {
      if (caption !== undefined) store.setCaption(media.id, caption);
      if (position !== undefined) place(store.mediaOfNote(note.id), media, position);
      store.touchNote(note.id, nowIso());
      store.bump(ctx.trip.id);
    });
    return json(mediaOut(store.mediaById(ctx.trip.id, media.id) as MediaRow, ctx.scope));
  }

  function deleteMedia(ctx: TripCtx, key: string, id: string): Response {
    const { note, media } = mediaOfNoteOrThrow(ctx, key, id);
    store.tx(() => {
      store.deleteMedia(media.id);
      store.setOrder(store.mediaOfNote(note.id).map((m) => m.id));
      store.touchNote(note.id, nowIso());
      store.bump(ctx.trip.id);
    });
    return empty();
  }

  async function serveMedia(
    trip: TripRow,
    id: string,
    size: string,
    req: Request,
    url: URL,
    editable: boolean,
  ): Promise<Response> {
    if (size !== "thumb" && size !== "preview" && size !== "video") throw new HttpError(404, "not found");
    const m = /^\d{1,12}$/.test(id) ? store.mediaById(trip.id, Number(id)) : null;
    if (!m || (size === "video" && m.type !== "video")) throw new HttpError(404, "not found");
    if (m.unavailable_at && !editable) throw new HttpError(404, "not found");
    const cache = url.searchParams.get("v") === m.v ? "private, max-age=31536000, immutable" : "private, max-age=300";
    return proxyImmich(m.immich_id as string, size, req.headers.get("range"), cache);
  }

  /** One size of an Immich asset, streamed through; a failing picture becomes the placeholder. */
  async function proxyImmich(id: string, size: MediaSize, range: string | null, cache: string): Promise<Response> {
    let upstream: Response;
    try {
      upstream = await immich.media(id, size, range);
    } catch {
      upstream = new Response(null, { status: 502 });
    }
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
      await upstream.body?.cancel();
      if (size === "video") throw new HttpError(502, "Immich did not deliver the video");
      return text(PLACEHOLDER, 200, "image/svg+xml", { ...MEDIA_CSP, "cache-control": "no-store" });
    }
    const headers = new Headers({ ...BASE_HEADERS, ...MEDIA_CSP });
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("cache-control", cache);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // ---- views

  function fullView(trip: TripRow, scope: ViewScope) {
    return buildView(store, trip, scope, now().getTime()).view;
  }

  function viewEtag(trip: TripRow, editable: boolean) {
    return `W/"${deps.version}-${trip.rev}-${editable ? "e" : "v"}"`;
  }

  function page(token: string, trip: TripRow, req: Request): Response {
    if (!deps.html) return text("client not built", 503);
    const editable = editorOf(req);
    const etag = `W/"p-${deps.version}-${trip.rev}-${editable ? "e" : "v"}"`;
    if (req.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { ...BASE_HEADERS, etag } });
    const view = fullView(trip, scopeFor(trip, `/api/t/${token}`, editable));
    const data = JSON.stringify(view).replace(/</g, "\\u003c");
    const html = deps.html.replace("<!--TRIP-->", () => data).replace("<!--TITLE-->", () => escapeHtml(trip.title));
    return text(html, 200, "text/html; charset=utf-8", {
      "content-security-policy": CSP,
      "cache-control": "no-cache",
      etag,
    });
  }

  // ---- admin

  /** A view share to hand out. It becomes the editor's `share_url`, so the trip's revision moves. */
  function newShare(trip: TripRow, label: string): ShareCreated {
    const token = newToken();
    const row = store.insertShare({
      trip_id: trip.id,
      role: "view",
      label,
      token_hash: hashToken(token),
      token,
      created: nowIso(),
      editor: 0,
      base_id: null,
    });
    store.bump(trip.id);
    return { ...shareOut(row, config.server.public_url), token, url: `${config.server.public_url}/${token}` };
  }

  /** A trip from a TripCreate, with its view share; the admin route and the editor's form share it. */
  function makeTrip(c: TripCreate): TripCreated {
    const slug = str(c.slug, "slug", 40);
    if (!SLUG.test(slug)) throw new HttpError(400, "slug must be lowercase letters, digits and dashes");
    if (store.tripBySlug(slug)) throw new HttpError(409, "slug is taken");
    return store.tx((): TripCreated => {
      const trip = store.insertTrip({
        slug,
        title: str(c.title, "title", LIMITS.title),
        short_title: optStr(c.short_title, "short_title", LIMITS.title),
        timezone: zone(c.timezone),
        start_date: c.start_date == null ? null : date(c.start_date, "start_date"),
        created: nowIso(),
        extra: JSON.stringify(c.extra == null ? {} : record(c.extra, "extra")),
        privacy: privacyJson(c.privacy, "{}"),
        day_offset: c.day_offset == null ? 0 : dayOffset(c.day_offset),
      });
      return { trip: tripOut(trip), view: newShare(trip, "friends") };
    });
  }

  /** Applies a TripPatch; the admin route and the editor's settings share it. */
  function changeTrip(trip: TripRow, p: TripPatch): TripRow {
    store.updateTrip(trip.id, {
      title: p.title === undefined ? trip.title : str(p.title, "title", LIMITS.title),
      short_title: p.short_title === undefined ? trip.short_title : optStr(p.short_title, "short_title", LIMITS.title),
      timezone: p.timezone === undefined ? trip.timezone : zone(p.timezone),
      start_date:
        p.start_date === undefined ? trip.start_date : p.start_date == null ? null : date(p.start_date, "start_date"),
      extra: p.extra === undefined ? trip.extra : JSON.stringify(record(p.extra, "extra")),
      privacy: p.privacy === undefined ? trip.privacy : privacyJson(p.privacy, trip.privacy),
      day_offset: p.day_offset === undefined ? trip.day_offset : dayOffset(p.day_offset),
    });
    return store.tripById(trip.id) as TripRow;
  }

  const TRIP_FIELDS = ["title", "short_title", "timezone", "start_date", "extra", "privacy", "day_offset"];

  async function createTrip(req: Request): Promise<Response> {
    const b = await body(req);
    only(b, ["slug", ...TRIP_FIELDS]);
    return json(makeTrip(b as unknown as TripCreate), 201);
  }

  async function patchTrip(trip: TripRow, req: Request): Promise<Response> {
    const b = await body(req);
    only(b, TRIP_FIELDS);
    return json(tripOut(changeTrip(trip, b as TripPatch)));
  }

  /** Revokes a share (an earlier edit share with its view share); 409 for an editor's view token whose edit share lives. */
  function revoke(trip: TripRow, target: ShareRow): void {
    if (target.editor && store.shares(trip.id).some((x) => x.base_id === target.id && !x.revoked_at))
      throw new HttpError(409, "this view token carries a live edit link; revoke the edit share instead");
    store.tx(() => {
      store.revokeShare(trip.id, target.id, nowIso());
      if (target.base_id != null) store.revokeShare(trip.id, target.base_id, nowIso());
      store.bump(trip.id);
    });
  }

  // ---- the editor's trip pages: forms over the same operations as the admin API

  const see = (location: string) =>
    new Response(null, { status: 303, headers: { ...BASE_HEADERS, location, "cache-control": "no-store" } });

  const html = (page: string, status = 200) =>
    text(page, status, "text/html; charset=utf-8", {
      "content-security-policy": FORM_CSP,
      "cache-control": "no-store",
    });

  async function form(req: Request): Promise<URLSearchParams> {
    if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
      throw new HttpError(400, "expected a form");
    return new URLSearchParams(await req.text());
  }

  const field = (f: URLSearchParams, name: string) => (f.get(name) ?? "").trim();

  const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

  /** Checks the fields a form shares; null, or the German sentence the form comes back with. */
  function formProblem(v: { title: string; timezone: string; start_date: string; end_date?: string | null }) {
    if (!v.title) return "Bitte einen Titel angeben.";
    if (!v.timezone) return "Bitte eine Zeitzone angeben.";
    try {
      new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    } catch {
      return `„${v.timezone}“ ist keine Zeitzone. Beispiele: Europe/Berlin, Europe/Paris.`;
    }
    if (v.start_date && !validDate(v.start_date)) return "Der erste Tag ist kein Datum.";
    if (v.end_date && !validDate(v.end_date)) return "Der letzte Tag ist kein Datum.";
    if (v.start_date && v.end_date && v.end_date < v.start_date) return "Der letzte Tag liegt vor dem ersten.";
    return null;
  }

  /** An integer form field within [min, max], else null. */
  function formInt(v: string, min: number, max: number): number | null {
    if (!/^-?\d{1,4}$/.test(v)) return null;
    const n = Number(v);
    return n >= min && n <= max ? n : null;
  }

  const shortDate = (iso: string, tz: string) =>
    new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric", timeZone: tz });

  /** `extra.end_date`: a date, `open`, or undefined for a trip that has none. */
  const endOf = (trip: TripRow): string | undefined => {
    const e = (JSON.parse(trip.extra) as { end_date?: unknown }).end_date;
    return typeof e === "string" ? e : undefined;
  };

  function settingsFormOf(trip: TripRow): SettingsForm {
    const end = endOf(trip);
    const privacy = privacyOf(trip);
    return {
      title: trip.title,
      short_title: trip.short_title ?? "",
      timezone: trip.timezone,
      start_date: trip.start_date ?? "",
      end_date: end === undefined ? null : end === "open" ? "" : end,
      first_day: String(trip.day_offset + 1),
      hide_camps: privacy.hide_camps,
      delay_hours: String(privacy.delay_hours),
    };
  }

  const NOTICES: Record<string, string> = {
    saved: "Gespeichert.",
    ended: "Die Reise endet heute.",
    link: "Neuer Link angelegt; ihn teilen ab jetzt die Knöpfe der Reise.",
    revoked: "Link widerrufen.",
  };

  function settings(
    trip: TripRow,
    o: { form?: SettingsForm; notice?: string | null; error?: string | null; status?: number } = {},
  ): Response {
    const token = editorToken(trip);
    const handout = handoutUrl(trip);
    const all = store.shares(trip.id);
    const links = all
      .filter((s) => s.role === "view" && !s.editor && !s.revoked_at && s.token)
      .reverse()
      .map((s) => {
        const url = `${config.server.public_url}/${s.token}`;
        return {
          id: s.id,
          label: s.label,
          created: shortDate(s.created, trip.timezone),
          url,
          handedOut: url === handout,
        };
      });
    const others = all.filter((s) => s.role === "view" && s.token && s.token !== token).map((s) => s.token as string);
    const revoked = all
      .filter((s) => s.role === "view" && !s.editor && s.revoked_at)
      .reverse()
      .map((s) => ({ label: s.label, revoked: shortDate(s.revoked_at as string, trip.timezone) }));
    return html(
      settingsPage(
        {
          slug: trip.slug,
          heading: trip.title,
          detail: tripDetail(trip),
          open: token ? `/${token}` : null,
          form: o.form ?? settingsFormOf(trip),
          canEnd: endOf(trip) === "open",
          links,
          revoked,
          drafts: token ? { to: token, from: others } : null,
          notice: o.notice ?? null,
          error: o.error ?? null,
        },
        ZONES,
      ),
      o.status,
    );
  }

  async function createFromForm(req: Request): Promise<Response> {
    const f = await form(req);
    const v: NewTripForm = {
      slug: field(f, "slug"),
      title: field(f, "title"),
      short_title: field(f, "short_title"),
      timezone: field(f, "timezone"),
      start_date: field(f, "start_date"),
      end_date: field(f, "end_date"),
    };
    const again = (status: number, error: string) => html(newTripPage(v, ZONES, error), status);
    const problem = formProblem(v);
    if (problem) return again(400, problem);
    if (!SLUG.test(v.slug) || v.slug.length > 40)
      return again(400, "Der Kurzname besteht aus Kleinbuchstaben, Ziffern und Bindestrichen, höchstens 40.");
    if (store.tripBySlug(v.slug)) return again(409, `Den Kurznamen „${v.slug}“ hat schon eine Reise.`);
    if (!v.start_date) return again(400, "Bitte den ersten Tag angeben.");
    try {
      const created = makeTrip({
        slug: v.slug,
        title: v.title,
        short_title: v.short_title || null,
        timezone: v.timezone,
        start_date: v.start_date,
        extra: { end_date: v.end_date || "open" },
      });
      return see(`/${created.view.token}`);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return again(e.status, `Nicht angelegt: ${e.message}`);
      throw e;
    }
  }

  async function saveSettings(trip: TripRow, req: Request): Promise<Response> {
    const f = await form(req);
    const had = settingsFormOf(trip);
    const v: SettingsForm = {
      title: field(f, "title"),
      short_title: field(f, "short_title"),
      timezone: field(f, "timezone"),
      start_date: field(f, "start_date"),
      // Only a trip that has an end has the field; any other keeps none.
      end_date: had.end_date == null ? null : field(f, "end_date"),
      first_day: field(f, "first_day"),
      hide_camps: f.get("hide_camps") != null,
      delay_hours: field(f, "delay_hours"),
    };
    const again = (status: number, error: string) => settings(trip, { form: v, error, status });
    const problem = formProblem(v);
    if (problem) return again(400, problem);
    const first = formInt(v.first_day, -98, 100);
    if (first == null) return again(400, "Der erste Tag heißt Tag … : eine ganze Zahl von -98 bis 100.");
    const delay = formInt(v.delay_hours, 0, 8760);
    if (delay == null) return again(400, "Stunden bis Notizen erscheinen: eine ganze Zahl von 0 bis 8760.");
    const patch: TripPatch = {
      title: v.title,
      short_title: v.short_title || null,
      timezone: v.timezone,
      start_date: v.start_date || null,
      privacy: { hide_camps: v.hide_camps, delay_hours: delay },
      day_offset: first - 1,
    };
    if (v.end_date != null) patch.extra = { ...JSON.parse(trip.extra), end_date: v.end_date || "open" };
    try {
      changeTrip(trip, patch);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return again(e.status, `Nicht gespeichert: ${e.message}`);
      throw e;
    }
    return see(`/trips/${trip.slug}?ok=saved`);
  }

  /** The editor's trip pages under /trips/; the routes are in src/shared/api.ts. */
  async function tripPages(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const post = req.method === "POST";
    if (req.method === "GET" || req.method === "HEAD") {
      const away = editorPage(req, path);
      if (away) return away;
    } else if (post) requireEditor(req);
    else throw new HttpError(404, "not found");
    if (path === "/trips/new") {
      if (post) return createFromForm(req);
      const blank = { slug: "", title: "", short_title: "", timezone: "", start_date: "", end_date: "" };
      return html(newTripPage(blank, ZONES));
    }
    const m = /^\/trips\/([a-z0-9-]+)(\/.*)?$/.exec(path);
    if (!m) throw new HttpError(404, "not found");
    const trip = tripOrThrow(m[1] as string);
    const rest = m[2] ?? "";
    if (rest === "") {
      if (post) return saveSettings(trip, req);
      return settings(trip, { notice: NOTICES[url.searchParams.get("ok") ?? ""] ?? null });
    }
    if (!post) throw new HttpError(404, "not found");
    if (rest === "/end") {
      if (endOf(trip) !== "open") return settings(trip, { error: "Diese Reise hat kein offenes Ende.", status: 409 });
      changeTrip(trip, { extra: { ...JSON.parse(trip.extra), end_date: localDate(now().getTime(), trip.timezone) } });
      return see(`/trips/${trip.slug}?ok=ended`);
    }
    if (rest === "/shares") {
      const label = field(await form(req), "label");
      if (!label || label.length > LIMITS.label)
        return settings(trip, {
          error: `Bitte angeben, für wen der Link ist (höchstens ${LIMITS.label} Zeichen).`,
          status: 400,
        });
      store.tx(() => newShare(trip, label));
      return see(`/trips/${trip.slug}?ok=link`);
    }
    const r = /^\/shares\/(\d{1,12})\/revoke$/.exec(rest);
    if (r) {
      const target = store.shareById(trip.id, Number(r[1]));
      if (target?.role !== "view" || target.editor || target.revoked_at)
        return settings(trip, { error: "Diesen Link gibt es nicht (mehr).", status: 404 });
      if (!editorToken(trip, target.id))
        return settings(trip, {
          error:
            "Das ist der letzte Link dieser Reise; ohne ihn ließe sie sich nicht mehr öffnen. Leg zuerst einen neuen an.",
          status: 409,
        });
      revoke(trip, target);
      return see(`/trips/${trip.slug}?ok=revoked`);
    }
    throw new HttpError(404, "not found");
  }

  function validDay(n: number, raw: Record<string, unknown>): Day {
    only(raw, ["date", "track", "breaks", "stats", "end", "source"]);
    const d = raw as unknown as DayPut;
    if (!Array.isArray(d.track)) throw new HttpError(400, "track must be an array");
    let prev = Number.NEGATIVE_INFINITY;
    const track = d.track.map((p, i): Day["track"][number] => {
      if (!Array.isArray(p) || p.length !== 4) throw new HttpError(400, `track[${i}] must be [lat, lon, ele, time]`);
      const t = parseIso(p[3]);
      if (!Number.isFinite(t)) throw new HttpError(400, `track[${i}] time is invalid`);
      if (t < prev) throw new HttpError(400, `track[${i}] is earlier than the point before it`);
      prev = t;
      const ele = p[2] == null ? null : Number(p[2]);
      if (ele != null && !Number.isFinite(ele)) throw new HttpError(400, `track[${i}] elevation is invalid`);
      return [coord(p[0], "lat"), coord(p[1], "lon"), ele, p[3] as string];
    });
    const breaks = d.breaks ?? [];
    if (!Array.isArray(breaks)) throw new HttpError(400, "breaks must be an array");
    breaks.forEach((b, i) => {
      if (!Number.isInteger(b) || b < 1 || b > track.length - 1)
        throw new HttpError(400, `breaks[${i}] must be an index of a track point after the first`);
      if (i > 0 && b <= (breaks[i - 1] as number))
        throw new HttpError(400, `breaks[${i}] must be larger than the one before`);
    });
    let end: Day["end"] = null;
    if (d.end != null) {
      const e = record(d.end, "end");
      const camp = e.camp_type ?? null;
      if (camp !== null && camp !== "wild" && camp !== "nature" && camp !== "trekking")
        throw new HttpError(400, "end.camp_type must be wild, nature, trekking or null");
      end = {
        lat: coord(e.lat, "lat"),
        lon: coord(e.lon, "lon"),
        camp_type: camp,
        name: optStr(e.name, "end.name", LIMITS.title),
        ...(e.osm != null ? { osm: str(e.osm, "end.osm", 100) } : {}),
      };
    }
    return {
      n,
      date: date(d.date, "date"),
      track,
      ...(breaks.length ? { breaks } : {}),
      stats: d.stats == null ? null : (record(d.stats, "stats") as Day["stats"]),
      end,
      source: d.source == null ? null : record(d.source, "source"),
    };
  }

  async function putDay(trip: TripRow, nRaw: string, req: Request): Promise<Response> {
    const n = Number(nRaw);
    if (!/^[1-9]\d{0,3}$/.test(nRaw)) throw new HttpError(400, "day must be a positive integer");
    const day = validDay(n, await body(req));
    store.tx(() => {
      store.putDay(trip.id, day);
      if (!store.noteByDay(trip.id, n))
        store.insertNote({
          trip_id: trip.id,
          kind: "day",
          number: null,
          day_n: n,
          lat: null,
          lon: null,
          title: "",
          text: "",
          created: nowIso(),
          updated: nowIso(),
          at: null,
          extra: "{}",
        });
      store.bump(trip.id);
    });
    return json(day);
  }

  function deleteDay(trip: TripRow, nRaw: string): Response {
    const n = Number(nRaw);
    const note = store.noteByDay(trip.id, n);
    if (note && (note.text || note.title || store.mediaOfNote(note.id).length))
      throw new HttpError(409, "the day-end note has content; clear it first");
    const gone = store.tx(() => {
      if (note) store.deleteNote(note.id);
      const ok = store.deleteDay(trip.id, n);
      store.bump(trip.id);
      return ok;
    });
    if (!gone) throw new HttpError(404, "day not found");
    return empty();
  }

  async function putWaypoints(trip: TripRow, req: Request): Promise<Response> {
    const raw = JSON.parse((await req.text()) || "null");
    if (!Array.isArray(raw)) throw new HttpError(400, "body must be an array of waypoints");
    const ids = new Set<string>();
    const list = raw.map((w: unknown, i: number): Waypoint => {
      const o = obj(w);
      only(o, ["id", "name", "kind", "lat", "lon", "day", "passed_time", "notes"]);
      const id = str(o.id, `[${i}].id`, 40);
      if (ids.has(id)) throw new HttpError(400, `waypoint id ${id} is repeated`);
      ids.add(id);
      return {
        id,
        name: str(o.name, `[${i}].name`, LIMITS.title),
        kind: str(o.kind, `[${i}].kind`, 40),
        lat: coord(o.lat, "lat"),
        lon: coord(o.lon, "lon"),
        day: o.day == null ? null : int(o.day, `[${i}].day`, 1),
        passed_time: o.passed_time == null ? null : iso(o.passed_time, `[${i}].passed_time`),
        notes: optStr(o.notes, `[${i}].notes`, LIMITS.caption),
      };
    });
    store.tx(() => {
      store.replaceWaypoints(trip.id, list);
      store.bump(trip.id);
    });
    return json(store.waypoints(trip.id));
  }

  async function suggest(trip: TripRow, url: URL, scope: ViewScope): Promise<Response> {
    const { view, prepared } = buildView(store, trip, scope, now().getTime());
    // The search never leaves the trip's window: the asset.read key would otherwise list the
    // whole library with places and times. Notes widen it, so a day whose track is not recorded
    // yet can be searched while it is written.
    const tracks = prepared.days.flatMap((d) => d.pts.map((p) => p.t));
    const dates = [trip.start_date, ...prepared.days.map((d) => d.date)].filter((d): d is string => !!d).sort();
    const times = [
      ...tracks,
      ...view.notes.map((n) => Date.parse(n.anchor.t)),
      ...(dates.length
        ? [
            zonedInstant(dates[0] as string, 0, 0, trip.timezone),
            zonedInstant(dates.at(-1) as string, 0, 0, trip.timezone) + 86_400_000,
          ]
        : []),
    ];
    if (!times.length) throw new HttpError(400, "the trip has neither tracks nor dates to search in");
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const MARGIN = 12 * 3_600_000;
    const fromQ = url.searchParams.get("from");
    const toQ = url.searchParams.get("to");
    const span = tracks.length ? [Math.min(...tracks), Math.max(...tracks)] : [lo, hi];
    const fromT = Math.max(lo - MARGIN, fromQ ? Date.parse(iso(fromQ, "from")) : (span[0] as number) - 3_600_000);
    const toT = Math.min(hi + MARGIN, toQ ? Date.parse(iso(toQ, "to")) : (span[1] as number) + 3_600_000);
    if (toT <= fromT) return json([]);
    const from = new Date(fromT).toISOString();
    const to = new Date(toT).toISOString();
    let assets: AssetInfo[];
    try {
      assets = await immich.search(from, to);
    } catch (e) {
      if (e instanceof ImmichError) throw new HttpError(502, e.message);
      throw e;
    }
    const numbered = view.notes.filter((n) => n.kind === "note");
    const out: Suggestion[] = assets.map((a) => {
      let nearest: Suggestion["nearest_note"] = null;
      if (a.lat != null && a.lon != null)
        for (const n of numbered) {
          if (n.lat == null || n.lon == null) continue;
          const d = Math.round(haversineM(a.lat, a.lon, n.lat, n.lon));
          if (!nearest || d < nearest.dist_m) nearest = { key: n.key, dist_m: d };
        }
      const t = a.taken_at ? Date.parse(a.taken_at) : Number.NaN;
      const pos = Number.isFinite(t) ? positionAt(t, prepared) : null;
      return {
        immich_id: a.id,
        type: a.type,
        taken_at: Number.isFinite(t) ? isoInZone(t, trip.timezone) : (a.taken_at as string),
        lat: a.lat,
        lon: a.lon,
        duration_ms: a.duration_ms,
        attached_to: view.notes.filter((n) => n.media.some((m) => m.immich_id === a.id)).map((n) => n.key),
        nearest_note: nearest,
        track: pos
          ? { day: pos.day, lat: Math.round(pos.lat * 1e6) / 1e6, lon: Math.round(pos.lon * 1e6) / 1e6 }
          : null,
      };
    });
    return json(out);
  }

  // ---- routing

  async function route(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    let m: RegExpExecArray | null;

    if (path === "/healthz") return json({ ok: true, version: deps.version });
    if (path === "/robots.txt") return text("User-agent: *\nDisallow: /\n", 200);
    if (path.startsWith("/assets/") && (method === "GET" || method === "HEAD")) {
      const name = path.slice("/assets/".length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(404, "not found");
      const f = Bun.file(join(config.web.dir, "assets", name));
      if (!(await f.exists())) throw new HttpError(404, "not found");
      return new Response(f, { headers: { ...BASE_HEADERS, "cache-control": "public, max-age=31536000, immutable" } });
    }

    if (path === "/" && method === "GET") return home(req);
    if (path.startsWith("/trips/")) return tripPages(req, url);

    // A map's page and API
    if (!config.maps.enabled && /^\/(m\/|preview\/|api\/m\/|api\/admin\/maps)/.test(path))
      throw new HttpError(404, "not found");
    if ((m = /^\/m\/([^/]+)$/.exec(path)) && method === "GET") return maps.page(m[1] as string, req);
    if ((m = /^\/preview\/([^/]+)\.jpg$/.exec(path)) && (method === "GET" || method === "HEAD"))
      return maps.preview(m[1] as string);
    if ((m = /^\/api\/m\/([^/]+)(\/.*)?$/.exec(path))) return maps.api(m[1] as string, m[2] ?? "", req, url);

    // Public view page
    if ((m = /^\/([A-Za-z0-9_-]{22})$/.exec(path)) && method === "GET") {
      const token = m[1] as string;
      return page(token, viewShare(token).trip, req);
    }

    // View / edit API
    if ((m = /^\/api\/t\/([^/]+)(\/.*)?$/.exec(path))) {
      const token = m[1] as string;
      const rest = m[2] ?? "";
      const { trip } = viewShare(token);
      const base = `/api/t/${token}`;
      if (rest === "" && method === "GET") {
        const editable = editorOf(req);
        const etag = viewEtag(trip, editable);
        if (req.headers.get("if-none-match") === etag)
          return new Response(null, { status: 304, headers: { ...BASE_HEADERS, etag } });
        return json(fullView(trip, scopeFor(trip, base, editable)), 200, {
          etag,
          "cache-control": "no-cache",
        });
      }
      if ((m = /^\/m\/([^/]+)\/([^/]+)$/.exec(rest)) && method === "GET")
        return serveMedia(trip, m[1] as string, m[2] as string, req, url, editorOf(req));
      // The photo picker's reads: the editor only, but no Origin, which browsers leave off a
      // same-origin GET and an <img>.
      if (method === "GET" && (rest === "/suggest" || rest.startsWith("/immich/"))) {
        if (!editorOf(req)) throw new HttpError(403, "this link is read-only");
        if (rest === "/suggest") return suggest(trip, url, scopeFor(trip, base, true));
        if ((m = /^\/immich\/([^/]+)\/thumb$/.exec(rest)))
          return proxyImmich(immichId(m[1], "asset id"), "thumb", null, "private, max-age=86400");
      }
      requireEditor(req);
      return editRoutes({ trip, admin: false, scope: scopeFor(trip, base, true) }, rest, req);
    }

    // Admin API
    if (path === "/api/admin/trips" || path.startsWith("/api/admin/")) {
      requireAdmin(req);
      if ((m = /^\/api\/admin\/maps(\/.*)?$/.exec(path))) return maps.admin(m[1] ?? "", req, url);
      if (path === "/api/admin/trips") {
        if (method === "GET") {
          const out: TripSummary[] = store.trips().map((t) => {
            const notes = store.notes(t.id);
            return {
              slug: t.slug,
              title: t.title,
              days: store.days(t.id).length,
              notes: notes.filter((n) => n.kind === "note").length,
              media: store.mediaOfTrip(t.id).length,
              rev: t.rev,
            };
          });
          return json(out);
        }
        if (method === "POST") return createTrip(req);
      }
      if ((m = /^\/api\/admin\/trips\/([a-z0-9-]+)(\/.*)?$/.exec(path))) {
        const trip = tripOrThrow(m[1] as string);
        const rest = m[2] ?? "";
        const base = `/api/admin/trips/${trip.slug}`;
        if (rest === "") {
          if (method === "GET") {
            const v: TripAdminView = {
              ...fullView(trip, scopeFor(trip, base, true)),
              shares: store.shares(trip.id).map((s) => shareOut(s, config.server.public_url)),
            };
            return json(v);
          }
          if (method === "PATCH") return patchTrip(trip, req);
        }
        if (rest === "/shares") {
          if (method === "GET") return json(store.shares(trip.id).map((s) => shareOut(s, config.server.public_url)));
          if (method === "POST") {
            const b = await body(req);
            only(b, ["role", "label"]);
            const s = b as unknown as ShareCreate;
            if (s.role !== "view") throw new HttpError(400, "role must be view; editing goes through the login");
            const label = str(s.label, "label", LIMITS.label);
            return json(
              store.tx(() => newShare(trip, label)),
              201,
            );
          }
        }
        if ((m = /^\/shares\/(\d+)$/.exec(rest)) && method === "DELETE") {
          const target = store.shareById(trip.id, Number(m[1]));
          if (!target || target.revoked_at) throw new HttpError(404, "share not found or already revoked");
          revoke(trip, target);
          return empty();
        }
        if ((m = /^\/days\/([^/]+)$/.exec(rest))) {
          if (method === "PUT") return putDay(trip, m[1] as string, req);
          if (method === "DELETE") return deleteDay(trip, m[1] as string);
        }
        if (rest === "/waypoints" && method === "PUT") return putWaypoints(trip, req);
        if (rest === "/suggest" && method === "GET") return suggest(trip, url, scopeFor(trip, base, true));
        if ((m = /^\/m\/([^/]+)\/([^/]+)$/.exec(rest)) && method === "GET")
          return serveMedia(trip, m[1] as string, m[2] as string, req, url, true);
        return editRoutes({ trip, admin: true, scope: scopeFor(trip, base, true) }, rest, req);
      }
    }
    throw new HttpError(404, "not found");
  }

  async function editRoutes(ctx: TripCtx, rest: string, req: Request): Promise<Response> {
    const method = req.method;
    let m: RegExpExecArray | null;
    if (rest === "/notes" && method === "POST") return createNote(ctx, req);
    if ((m = /^\/notes\/([^/]+)$/.exec(rest))) {
      if (method === "GET") return json(renderNote(ctx, noteRow(ctx.trip, m[1] as string)));
      if (method === "PATCH") return patchNote(ctx, m[1] as string, req);
      if (method === "DELETE") return deleteNote(ctx, m[1] as string);
    }
    if ((m = /^\/notes\/([^/]+)\/media$/.exec(rest)) && method === "POST") return addMedia(ctx, m[1] as string, req);
    if ((m = /^\/notes\/([^/]+)\/media\/([^/]+)$/.exec(rest))) {
      if (method === "PATCH") return patchMedia(ctx, m[1] as string, m[2] as string, req);
      if (method === "DELETE") return deleteMedia(ctx, m[1] as string, m[2] as string);
    }
    throw new HttpError(404, "not found");
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    try {
      return await route(req, url);
    } catch (e) {
      if (e instanceof HttpError) {
        const res = { error: e.message, ...e.extra };
        if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return json(res, e.status);
        return text(e.status === 404 ? "Not found\n" : `${e.message}\n`, e.status);
      }
      if (e instanceof SyntaxError) return json({ error: "body is not valid JSON" }, 400);
      console.error(`${req.method} ${url.pathname.replace(/[A-Za-z0-9_-]{22}/g, "<token>")}:`, e);
      return json({ error: "internal error" }, 500);
    }
  };
}
