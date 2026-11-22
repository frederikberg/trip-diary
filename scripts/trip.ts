#!/usr/bin/env bun
// trip: command line for the trip-diary admin API. `trip --help` lists the commands; docs/cli.md explains them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  DayPut,
  Entry,
  EntryCreate,
  EntryPatch,
  EntryRev,
  EntryWritten,
  GeoHit,
  MapAdminView,
  MapCreated,
  MapInfo,
  MapShare,
  MapShareCreated,
  MapSummary,
  Media,
  MeetMemberPut,
  MeetState,
  Note,
  NoteCreate,
  NotePatch,
  PlaceInput,
  Share,
  ShareCreated,
  Suggestion,
  TripAdminView,
  TripCreated,
  TripPatch,
  TripSummary,
  Waypoint,
} from "../src/shared/api";
import { isoInZone, localDate, zonedInstant } from "../src/shared/time";
import { dayFromGpx, type GpxPoint, parseGpx } from "./gpx";

const USAGE = `usage: trip [--json] [--url URL] [--token-file FILE] <command>

The server comes from --url or TRIP_URL, the admin token from --token-file or TRIP_ADMIN_TOKEN.

  ls                                              trips
  new <slug> --title T --timezone Z [--short-title S] [--start-date D]
  show <trip>                                     days and notes at a glance
  set <trip> [--title T] [--short-title S] [--timezone Z] [--start-date D]
  links <trip>                                    shares and their links
  share <trip> --label L                          new view share
  share <trip> --revoke <id>

  days import-gpx <trip> <file.gpx>… [--first-day N]   one day per date, in date order; several recordings of a date make one day with gaps
  days import <trip> <days.json> [--no-waypoints]      days (and waypoints) as JSON: the shape of the trip.json of an export
  days rm <trip> <n>

  note <trip> [<key>]                             list, or print one (key: 7 or d3)
  note set <trip> <key> [--title T] [--text S | --text-file F|-] [--append] [--at ISO|none]
  note add <trip> (--lat N --lon N | --from-asset ID|LINK | --no-place) [--title T] [--text S | --text-file F|-] [--at ISO] [--number N]
  note mv <trip> <n> (--lat N --lon N | --no-place)
  note rm <trip> <n>

  media attach <trip> <key> <asset ID|LINK>… [--caption C]
  media rm <trip> <key> <mediaId>
  media order <trip> <key> <mediaId>…             these first, in this order
  media suggest <trip> [--day N] [--from ISO --to ISO] [--pad MIN]

  export <trip> <dir>                             trip.json, notes/*.md

  map ls                                          maps of people and places
  map new <slug> --title T                        prints the read link and the write link
  map show <map>                                  entries at a glance
  map set <map> --title T
  map rm <map>                                    deletes the map with everything on it
  map links <map>                                 shares and their links
  map share <map> --role view|edit --label L      another link
  map share <map> --revoke <id>
  map geocode <map> (<text> | --lat N --lon N)    address search through the app's geocoder

  map entry add <map> --name N [--emoji E] [--note S] [--by B] [--place 'label|address|lat|lon']…
  map entry set <map> <id> [--name N] [--emoji E|none] [--note S] [--by B] [--place …]…   --place replaces all places
  map entry rm <map> <id>
  map entry restore <map> <id> [--rev N]          undelete, or put a history state back
  map entry purge <map> <id>                      a deleted entry gone for good, history included
  map entry history <map> <id>
  map entry avatar <map> <id> (<file.jpg|png|webp> | --clear)     a square of at most 512 px and 128 KiB

  map meet <map>                                  selection, middle, last result
  map meet set <map> <entryId> [--weight N] [--mode car|train] [--place ID]     puts the entry in
  map meet rm <map> <entryId>
  map meet compute <map> [--wait]                 for everybody; --wait prints the result
`;

class CliFail extends Error {}

class ApiFail extends CliFail {
  constructor(
    readonly status: number,
    message: string,
    readonly note?: Note,
  ) {
    super(message);
  }
}

// parseArgs rejects `--lat -3.5` as ambiguous; join a negative number to its flag.
const argv = Bun.argv.slice(2).reduce<string[]>((acc, a) => {
  if (/^-\d/.test(a) && /^--[a-z-]+$/.test(acc.at(-1) ?? "")) acc[acc.length - 1] += `=${a}`;
  else acc.push(a);
  return acc;
}, []);

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  url: { type: "string" },
  "token-file": { type: "string" },
  title: { type: "string" },
  "short-title": { type: "string" },
  timezone: { type: "string" },
  "start-date": { type: "string" },
  label: { type: "string" },
  revoke: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  append: { type: "boolean" },
  at: { type: "string" },
  lat: { type: "string" },
  lon: { type: "string" },
  "from-asset": { type: "string" },
  "no-place": { type: "boolean" },
  number: { type: "string" },
  caption: { type: "string" },
  day: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  pad: { type: "string" },
  "no-waypoints": { type: "boolean" },
  "first-day": { type: "string" },
  role: { type: "string" },
  name: { type: "string" },
  emoji: { type: "string" },
  note: { type: "string" },
  by: { type: "string" },
  place: { type: "string", multiple: true },
  rev: { type: "string" },
  weight: { type: "string" },
  mode: { type: "string" },
  clear: { type: "boolean" },
  wait: { type: "boolean" },
} as const;

function parse() {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    console.error(`trip: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    process.exit(1);
  }
}
const { values: o, positionals: pos } = parse();

// ═══ transport ════════════════════════════════════════════════════════════

let tokenCache: string | undefined;
async function adminToken(): Promise<string> {
  if (tokenCache) return tokenCache;
  if (o["token-file"]) tokenCache = readFileSync(o["token-file"], "utf8").trim();
  else tokenCache = process.env.TRIP_ADMIN_TOKEN?.trim();
  if (!tokenCache) throw new CliFail("no admin token: set TRIP_ADMIN_TOKEN or pass --token-file");
  return tokenCache;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = o.url ?? process.env.TRIP_URL;
  if (!url) throw new CliFail("no server: set TRIP_URL or pass --url");
  const base = url.replace(/\/+$/, "");
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken()}`, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return res;
  let err: { error?: string; note?: Note } = {};
  try {
    err = await res.json();
  } catch {}
  throw new ApiFail(res.status, `${method} ${path}: ${res.status} ${err.error ?? res.statusText}`, err.note);
}

async function api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await call(method, path, body, headers);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const tripPath = (slug: string) => `/api/admin/trips/${encodeURIComponent(slug)}`;
const view = (slug: string) => api<TripAdminView>("GET", tripPath(slug));

// ═══ helpers ══════════════════════════════════════════════════════════════

const emit = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function need(a: string[], n: 1, usage: string): [string, ...string[]];
function need(a: string[], n: 2, usage: string): [string, string, ...string[]];
function need(a: string[], n: 3, usage: string): [string, string, string, ...string[]];
function need(a: string[], n: number, usage: string): string[] {
  if (a.length < n) throw new CliFail(`usage: trip ${usage}`);
  return a;
}

function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new CliFail(`--${name} needs a number, got '${v}'`);
  return n;
}

function noteKey(k: string): string {
  if (!/^(\d+|d\d+)$/.test(k)) throw new CliFail(`note key '${k}': use a number (7) or d<day> (d3)`);
  return k;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** An Immich asset id from a bare id or a photo link (`…/photos/<id>`, also under /albums/ and /people/). */
function assetId(s: string): string {
  const afterPhotos = s.match(/\/photos\/([0-9a-f-]{36})/i);
  if (afterPhotos) return (afterPhotos[1] as string).toLowerCase();
  if (new RegExp(`^${UUID.source}$`, "i").test(s)) return s.toLowerCase();
  throw new CliFail(`'${s}' is neither an Immich asset id nor a photo link`);
}

function textArg(): string | undefined {
  if (o.text !== undefined && o["text-file"] !== undefined)
    throw new CliFail("--text and --text-file exclude each other");
  if (o["text-file"] !== undefined) return readFileSync(o["text-file"] === "-" ? 0 : o["text-file"], "utf8");
  return o.text;
}

function atArg(): string | null | undefined {
  return o.at === undefined ? undefined : o.at === "none" ? null : o.at;
}

const getNote = (slug: string, key: string) => api<Note>("GET", `${tripPath(slug)}/notes/${key}`);

const notePos = (n: Note) => (n.lat == null ? "no place" : `${n.lat},${n.lon}`);

const line = (n: Note) =>
  `${n.key.padEnd(4)} ${n.anchor.t.slice(0, 16)}  day ${n.anchor.day ?? "-"}${n.anchor.off_track ? " off-track" : ""}${n.kind === "note" && n.lat == null ? " no-place" : ""}  ${n.media.length ? `${n.media.length} media  ` : ""}${n.title || (n.text.split("\n")[0] ?? "").slice(0, 60)}`;

function shiftIso(iso: string, minutes: number): string {
  if (!minutes) return iso;
  const m = iso.match(/([+-]\d\d:\d\d|Z)$/);
  const off = m?.[1] && m[1] !== "Z" ? m[1] : "+00:00";
  const sign = off[0] === "-" ? -1 : 1;
  const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  const local = new Date(Date.parse(iso) + minutes * 60000 + offMin * 60000).toISOString().slice(0, 19);
  return `${local}${off}`;
}

// ═══ commands ═════════════════════════════════════════════════════════════

type Handler = (a: string[]) => Promise<void>;

const trips: Handler = async () => {
  const list = await api<TripSummary[]>("GET", "/api/admin/trips");
  if (o.json) return emit(list);
  for (const t of list)
    console.log(
      `${t.slug.padEnd(14)} ${String(t.days).padStart(2)} days ${String(t.notes).padStart(3)} notes ${String(t.media).padStart(3)} media  rev ${t.rev}  ${t.title}`,
    );
};

const newTrip: Handler = async (a) => {
  const [slug] = need(a, 1, "new <slug> --title T --timezone Z");
  if (!o.title || !o.timezone) throw new CliFail("new needs --title and --timezone");
  const body = {
    slug,
    title: o.title,
    timezone: o.timezone,
    short_title: o["short-title"],
    start_date: o["start-date"],
  };
  const r = await api<TripCreated>("POST", "/api/admin/trips", body);
  if (o.json) return emit(r);
  console.log(`created ${r.trip.slug}\nview  ${r.view.url}`);
};

const show: Handler = async (a) => {
  const [slug] = need(a, 1, "show <trip>");
  const v = await view(slug);
  if (o.json) return emit(v);
  console.log(`${v.trip.slug}  ${v.trip.title}  (${v.trip.timezone}, rev ${v.rev})`);
  for (const d of v.days)
    console.log(
      `day ${d.n}  ${d.date}  ${d.stats ? `${d.stats.km} km  +${d.stats.ascent_m} m` : "no track"}${d.end?.name ? `  camp ${d.end.name}` : ""}`,
    );
  console.log(`${v.waypoints.length} waypoints`);
  for (const n of v.notes) console.log(line(n));
};

const setTrip: Handler = async (a) => {
  const [slug] = need(a, 1, "set <trip> [--title …]");
  const patch: TripPatch = {};
  if (o.title !== undefined) patch.title = o.title;
  if (o["short-title"] !== undefined) patch.short_title = o["short-title"] === "none" ? null : o["short-title"];
  if (o.timezone !== undefined) patch.timezone = o.timezone;
  if (o["start-date"] !== undefined) patch.start_date = o["start-date"] === "none" ? null : o["start-date"];
  if (!Object.keys(patch).length) throw new CliFail("set: nothing to change");
  emit(await api("PATCH", tripPath(slug), patch));
};

const links: Handler = async (a) => {
  const [slug] = need(a, 1, "links <trip>");
  const shares = await api<Share[]>("GET", `${tripPath(slug)}/shares`);
  if (o.json) return emit(shares);
  for (const s of shares)
    console.log(
      `${String(s.id).padStart(3)} ${s.role.padEnd(4)} ${s.revoked_at ? "revoked" : "live   "} ${s.label.padEnd(16)} ${s.url ?? "(no link: an earlier edit share)"}`,
    );
};

const share: Handler = async (a) => {
  const [slug] = need(a, 1, "share <trip> --label L | --revoke ID");
  if (o.revoke !== undefined) {
    await api("DELETE", `${tripPath(slug)}/shares/${encodeURIComponent(o.revoke)}`);
    console.log(`revoked share ${o.revoke}`);
    return;
  }
  if (!o.label) throw new CliFail("share needs --label (or --revoke ID)");
  const r = await api<ShareCreated>("POST", `${tripPath(slug)}/shares`, { role: "view", label: o.label });
  if (o.json) return emit(r);
  console.log(`${r.id} ${r.role} ${r.label}\n${r.url}`);
};

/** Days as `days import` reads them: `day` or `n` numbers a day (an export's trip.json has `n`); waypoints may lack `passed_time`. */
interface DiaryDay extends Partial<DayPut> {
  day?: number;
  n?: number;
}

const daysImport: Handler = async (a) => {
  const [slug, file] = need(a, 2, "days import <trip> <days.json>");
  const data = JSON.parse(readFileSync(file, "utf8")) as { days?: DiaryDay[]; waypoints?: Partial<Waypoint>[] };
  if (!Array.isArray(data.days)) throw new CliFail(`${file}: no "days" array`);
  const done: string[] = [];
  for (const d of data.days) {
    const n = d.day ?? d.n;
    if (!Number.isInteger(n) || !d.date) throw new CliFail(`${file}: a day lacks "day" (or "n") or "date"`);
    const put: DayPut = {
      date: d.date,
      track: d.track ?? [],
      ...(d.breaks?.length ? { breaks: d.breaks } : {}),
      stats: d.stats ?? null,
      end: d.end ? { ...d.end, camp_type: d.end.camp_type ?? null, name: d.end.name ?? null } : null,
      source: d.source ?? null,
    };
    await api("PUT", `${tripPath(slug)}/days/${n}`, put);
    done.push(`day ${n}: ${put.track.length} points`);
  }
  let wp = "";
  if (!o["no-waypoints"] && Array.isArray(data.waypoints)) {
    const list = data.waypoints.map(
      (w): Waypoint => ({
        id: w.id as string,
        name: w.name as string,
        kind: w.kind as string,
        lat: w.lat as number,
        lon: w.lon as number,
        day: w.day ?? null,
        passed_time: w.passed_time ?? null,
        notes: w.notes ?? null,
      }),
    );
    await api("PUT", `${tripPath(slug)}/waypoints`, list);
    wp = `${list.length} waypoints replaced`;
  }
  console.log([...done, wp].filter(Boolean).join("\n"));
};

const daysImportGpx: Handler = async (a) => {
  const [slug, ...files] = need(a, 2, "days import-gpx <trip> <file.gpx>…");
  const first = num("first-day", o["first-day"]) ?? 1;
  if (!Number.isInteger(first) || first < 1) throw new CliFail("--first-day must be a positive integer");
  const tz = (await view(slug)).trip.timezone;
  // Files whose recordings start on the same local date are one day, in start order.
  const parsed = files
    .map((file) => {
      const recordings = parseGpx(readFileSync(file, "utf8"), file);
      return { file: basename(file), recordings, start: Math.min(...recordings.map((r) => (r[0] as GpxPoint).ms)) };
    })
    .sort((x, y) => x.start - y.start);
  const byDate = new Map<string, { files: string[]; recordings: GpxPoint[][]; start: number }>();
  for (const f of parsed) {
    const date = localDate(f.start, tz);
    const day = byDate.get(date) ?? { files: [], recordings: [], start: f.start };
    day.files.push(f.file);
    day.recordings.push(...f.recordings);
    byDate.set(date, day);
  }
  const days = [...byDate.values()].sort((x, y) => x.start - y.start);
  const out: string[] = [];
  for (const [i, day] of days.entries()) {
    const n = first + i;
    const put = dayFromGpx(day.recordings, tz, day.files.join(", "));
    await api("PUT", `${tripPath(slug)}/days/${n}`, put);
    const parts = (put.breaks?.length ?? 0) + 1;
    out.push(
      `day ${n} ${put.date}: ${put.track.length} points, ${put.stats?.km} km${parts > 1 ? `, ${parts} recordings` : ""} (${day.files.join(", ")})`,
    );
  }
  console.log(out.join("\n"));
};

const daysRm: Handler = async (a) => {
  const [slug, n] = need(a, 2, "days rm <trip> <n>");
  await api("DELETE", `${tripPath(slug)}/days/${encodeURIComponent(n)}`);
  console.log(`removed day ${n}`);
};

function printNote(n: Note) {
  console.log(`${n.key}  ${n.title || "(no title)"}  [${n.kind}]  rev ${n.rev}`);
  console.log(
    `at ${n.anchor.t} (${n.anchor.rule}, day ${n.anchor.day ?? "-"}${n.anchor.km != null ? `, km ${n.anchor.km}` : ""}${n.anchor.off_track ? ", off track" : ""})  pos ${notePos(n)}${n.at ? `  manual at ${n.at}` : ""}`,
  );
  for (const m of n.media)
    console.log(
      `media ${m.id} #${m.position} ${m.type}${m.immich_id ? ` ${m.immich_id}` : ""} ${m.taken_at ?? ""}${m.caption ? `  "${m.caption}"` : ""}`,
    );
  console.log(`\n${n.text}`);
}

const noteShow: Handler = async (a) => {
  const [slug, key] = need(a, 1, "note <trip> [<key>]");
  if (key === undefined) {
    const v = await view(slug);
    if (o.json) return emit(v.notes);
    for (const n of v.notes) console.log(line(n));
    return;
  }
  const n = await getNote(slug, noteKey(key));
  if (o.json) return emit(n);
  printNote(n);
};

const noteSet: Handler = async (a) => {
  const [slug, rawKey] = need(a, 2, "note set <trip> <key> …");
  const key = noteKey(rawKey);
  const patch: NotePatch = {};
  if (o.title !== undefined) patch.title = o.title;
  const text = textArg();
  const at = atArg();
  if (at !== undefined) patch.at = at;
  let ifMatch: Record<string, string> | undefined;
  if (text !== undefined) {
    if (o.append) {
      const cur = await getNote(slug, key);
      patch.text = cur.text.trim() ? `${cur.text.replace(/\s+$/, "")}\n\n${text.replace(/^\s+/, "")}` : text;
      ifMatch = { "If-Match": String(cur.rev) };
    } else patch.text = text;
  } else if (o.append) throw new CliFail("--append needs --text or --text-file");
  if (!Object.keys(patch).length) throw new CliFail("note set: nothing to change");
  try {
    const n = await api<Note>("PATCH", `${tripPath(slug)}/notes/${key}`, patch, ifMatch);
    if (o.json) return emit(n);
    console.log(`updated ${line(n)}`);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 412)
      throw new CliFail(
        `${e.message}\nthe note changed meanwhile (rev ${e.note?.rev}); read it again with: trip note ${slug} ${key}`,
      );
    throw e;
  }
};

const noteAdd: Handler = async (a) => {
  const [slug] = need(a, 1, "note add <trip> (--lat --lon | --from-asset | --no-place)");
  const body: NoteCreate = {};
  if (o["no-place"] && (o.lat !== undefined || o.lon !== undefined || o["from-asset"] !== undefined))
    throw new CliFail("--no-place takes neither --lat/--lon nor --from-asset");
  if (o["no-place"]) {
    // Placed in the timeline by --at, else by the time it is made.
    body.lat = null;
    body.lon = null;
  } else if (o["from-asset"] !== undefined) {
    if (o.lat !== undefined || o.lon !== undefined) throw new CliFail("--from-asset replaces --lat/--lon");
    body.from_asset = assetId(o["from-asset"]);
  } else {
    if (o.lat === undefined || o.lon === undefined)
      throw new CliFail("note add needs --lat and --lon, --from-asset or --no-place");
    body.lat = num("lat", o.lat);
    body.lon = num("lon", o.lon);
  }
  if (o.title !== undefined) body.title = o.title;
  const text = textArg();
  if (text !== undefined) body.text = text;
  const at = atArg();
  if (at !== undefined) body.at = at;
  if (o.number !== undefined) body.number = num("number", o.number);
  const n = await api<Note>("POST", `${tripPath(slug)}/notes`, body);
  if (o.json) return emit(n);
  console.log(`created ${line(n)}\npos ${notePos(n)}  anchor ${n.anchor.rule}`);
};

const noteMv: Handler = async (a) => {
  const [slug, key] = need(a, 2, "note mv <trip> <n> (--lat N --lon N | --no-place)");
  let patch: NotePatch;
  if (o["no-place"]) {
    if (o.lat !== undefined || o.lon !== undefined) throw new CliFail("--no-place takes no --lat/--lon");
    // The server keeps the note's place in the timeline by giving it its anchor time as `at`.
    patch = { lat: null, lon: null };
  } else {
    if (o.lat === undefined || o.lon === undefined) throw new CliFail("note mv needs --lat and --lon, or --no-place");
    patch = { lat: num("lat", o.lat), lon: num("lon", o.lon) };
  }
  const n = await api<Note>("PATCH", `${tripPath(slug)}/notes/${noteKey(key)}`, patch);
  if (o.json) return emit(n);
  console.log(`moved ${line(n)}`);
};

const noteRm: Handler = async (a) => {
  const [slug, key] = need(a, 2, "note rm <trip> <n>");
  await api("DELETE", `${tripPath(slug)}/notes/${noteKey(key)}`);
  console.log(`deleted note ${key}`);
};

const mediaAttach: Handler = async (a) => {
  const [slug, key, ...assets] = need(a, 3, "media attach <trip> <key> <asset>…");
  if (o.caption !== undefined && assets.length > 1) throw new CliFail("--caption goes with a single asset");
  const out: Media[] = [];
  for (const s of assets) {
    const body = { immich_id: assetId(s), ...(o.caption !== undefined ? { caption: o.caption } : {}) };
    out.push(await api<Media>("POST", `${tripPath(slug)}/notes/${noteKey(key)}/media`, body));
  }
  if (o.json) return emit(out);
  for (const m of out) console.log(`attached media ${m.id} (${m.type}, #${m.position}) to note ${key}`);
};

const mediaRm: Handler = async (a) => {
  const [slug, key, id] = need(a, 3, "media rm <trip> <key> <mediaId>");
  await api("DELETE", `${tripPath(slug)}/notes/${noteKey(key)}/media/${encodeURIComponent(id)}`);
  console.log(`removed media ${id} from note ${key}`);
};

const mediaOrder: Handler = async (a) => {
  const [slug, rawKey, ...ids] = need(a, 3, "media order <trip> <key> <mediaId>…");
  const key = noteKey(rawKey);
  const cur = await getNote(slug, key);
  for (const id of ids)
    if (!cur.media.some((m) => String(m.id) === id)) throw new CliFail(`note ${key} has no media ${id}`);
  // Placing each id at its index in turn leaves the listed ones first, in order.
  for (const [i, id] of ids.entries())
    await api("PATCH", `${tripPath(slug)}/notes/${key}/media/${id}`, { position: i });
  const n = await getNote(slug, key);
  if (o.json) return emit(n.media);
  console.log(`note ${key} media order: ${n.media.map((m) => m.id).join(" ")}`);
};

const mediaSuggest: Handler = async (a) => {
  const [slug] = need(a, 1, "media suggest <trip> [--day N]");
  const q = new URLSearchParams();
  if (o.day !== undefined) {
    if (o.from || o.to) throw new CliFail("--day replaces --from/--to");
    const n = num("day", o.day);
    const v = await view(slug);
    const day = v.days.find((d) => d.n === n);
    if (!day) throw new CliFail(`trip '${slug}' has no day ${o.day}`);
    const tz = v.trip.timezone;
    const from = day.stats?.start_time ?? day.track[0]?.[3] ?? isoInZone(zonedInstant(day.date, 0, 0, tz), tz);
    const to =
      day.stats?.end_time ?? day.track.at(-1)?.[3] ?? isoInZone(zonedInstant(day.date, 23, 59, tz) + 59_000, tz);
    const pad = num("pad", o.pad) ?? 0;
    q.set("from", shiftIso(from, -pad));
    q.set("to", shiftIso(to, pad));
  } else {
    if (o.pad !== undefined) throw new CliFail("--pad goes with --day");
    if (o.from) q.set("from", o.from);
    if (o.to) q.set("to", o.to);
  }
  const list = await api<Suggestion[]>("GET", `${tripPath(slug)}/suggest${q.size ? `?${q}` : ""}`);
  if (o.json) return emit(list);
  if (!list.length) return console.log("no photos in the window");
  for (const s of list) {
    const where = s.lat != null ? `${s.lat.toFixed(5)},${s.lon?.toFixed(5)}` : "no GPS";
    const near = s.nearest_note
      ? `nearest note ${s.nearest_note.key} (${Math.round(s.nearest_note.dist_m)} m)`
      : "no note near";
    const trk = s.track ? `track day ${s.track.day}` : "off tracks";
    const att = s.attached_to.length ? `  attached to ${s.attached_to.join(",")}` : "";
    console.log(`${s.immich_id} ${s.type.padEnd(5)} ${s.taken_at}  ${where}  ${near}  ${trk}${att}`);
  }
};

const exportTrip: Handler = async (a) => {
  const [slug, dir] = need(a, 2, "export <trip> <dir>");
  const out = resolve(dir);
  const v = await view(slug);
  mkdirSync(join(out, "notes"), { recursive: true });
  // Shares hold capability links; the export is a content copy.
  const { shares: _shares, ...content } = v;
  writeFileSync(join(out, "trip.json"), `${JSON.stringify(content, null, 2)}\n`);
  for (const n of v.notes) {
    const media = n.media
      .map((m) => `- immich ${m.immich_id} ${m.type}${m.caption ? `: ${m.caption}` : ""}`)
      .join("\n");
    const head = `# ${n.key}${n.title ? ` ${n.title}` : ""}\n\n${n.anchor.t}  ${notePos(n)}\n\n`;
    writeFileSync(join(out, "notes", `${n.key}.md`), `${head}${n.text.trim()}\n${media ? `\n${media}\n` : ""}`);
  }
  console.log(`exported ${v.notes.length} notes to ${out}`);
};

// ═══ maps ═════════════════════════════════════════════════════════════════

const mapPath = (slug: string) => `/api/admin/maps/${encodeURIComponent(slug)}`;

/** `label|address|lat|lon` */
function placeArg(s: string): PlaceInput {
  const p = s.split("|");
  if (p.length !== 4) throw new CliFail(`--place '${s}': use 'label|address|lat|lon'`);
  const [label, address, lat, lon] = p;
  return {
    label: label as string,
    address: address as string,
    lat: num("place lat", lat) as number,
    lon: num("place lon", lon) as number,
  };
}

const entryLine = (e: Entry) =>
  `${String(e.id).padStart(4)} ${e.emoji ? `${e.emoji} ` : ""}${e.name}${e.deleted_at ? "  (deleted)" : ""}${e.places.length ? `  ${e.places.map((p) => [p.label, p.address].filter(Boolean).join(": ")).join(" · ")}` : "  no place"}`;

const mapLs: Handler = async () => {
  const list = await api<MapSummary[]>("GET", "/api/admin/maps");
  if (o.json) return emit(list);
  for (const m of list)
    console.log(`${m.slug.padEnd(14)} ${String(m.entries).padStart(3)} entries  rev ${m.rev}  ${m.title}`);
};

const mapNew: Handler = async (a) => {
  const [slug] = need(a, 1, "map new <slug> --title T");
  if (!o.title) throw new CliFail("map new needs --title");
  const r = await api<MapCreated>("POST", "/api/admin/maps", { slug, title: o.title });
  if (o.json) return emit(r);
  console.log(`created ${r.map.slug}\nview  ${r.view.url}\nedit  ${r.edit.url}`);
};

const mapShow: Handler = async (a) => {
  const [slug] = need(a, 1, "map show <map>");
  const v = await api<MapAdminView>("GET", mapPath(slug));
  if (o.json) return emit(v);
  console.log(`${v.map.slug}  ${v.map.title}  (rev ${v.rev})`);
  for (const e of [...v.entries, ...v.trash]) console.log(entryLine(e));
};

const mapSet: Handler = async (a) => {
  const [slug] = need(a, 1, "map set <map> --title T");
  if (o.title === undefined) throw new CliFail("map set: nothing to change");
  emit(await api<MapInfo>("PATCH", mapPath(slug), { title: o.title }));
};

const mapRm: Handler = async (a) => {
  const [slug] = need(a, 1, "map rm <map>");
  await api("DELETE", mapPath(slug));
  console.log(`deleted map ${slug}`);
};

const mapLinks: Handler = async (a) => {
  const [slug] = need(a, 1, "map links <map>");
  const shares = await api<MapShare[]>("GET", `${mapPath(slug)}/shares`);
  if (o.json) return emit(shares);
  for (const s of shares)
    console.log(
      `${String(s.id).padStart(3)} ${s.role.padEnd(4)} ${s.revoked_at ? "revoked" : "live   "} ${s.label.padEnd(16)} ${s.url}`,
    );
};

const mapShare: Handler = async (a) => {
  const [slug] = need(a, 1, "map share <map> --role view|edit --label L | --revoke ID");
  if (o.revoke !== undefined) {
    await api("DELETE", `${mapPath(slug)}/shares/${encodeURIComponent(o.revoke)}`);
    console.log(`revoked share ${o.revoke}`);
    return;
  }
  if (!o.role || !o.label) throw new CliFail("map share needs --role and --label (or --revoke ID)");
  const r = await api<MapShareCreated>("POST", `${mapPath(slug)}/shares`, { role: o.role, label: o.label });
  if (o.json) return emit(r);
  console.log(`${r.id} ${r.role} ${r.label}\n${r.url}`);
};

const mapGeocode: Handler = async (a) => {
  const [slug, ...text] = need(a, 1, "map geocode <map> (<text> | --lat N --lon N)");
  const q = new URLSearchParams();
  if (text.length) q.set("q", text.join(" "));
  if (o.lat !== undefined) q.set("lat", String(num("lat", o.lat)));
  if (o.lon !== undefined) q.set("lon", String(num("lon", o.lon)));
  const hits = await api<GeoHit[]>("GET", `${mapPath(slug)}/geocode?${q}`);
  if (o.json) return emit(hits);
  for (const h of hits) console.log(`${h.lat},${h.lon}  ${h.label}`);
};

function entryFields(): EntryPatch {
  const b: EntryPatch = {};
  if (o.name !== undefined) b.name = o.name;
  if (o.emoji !== undefined) b.emoji = o.emoji === "none" ? null : o.emoji;
  if (o.note !== undefined) b.note = o.note;
  if (o.by !== undefined) b.by = o.by;
  if (o.place !== undefined) b.places = o.place.map(placeArg);
  return b;
}

const entryPath = (slug: string, id: string) => `${mapPath(slug)}/entries/${encodeURIComponent(id)}`;

const entryAdd: Handler = async (a) => {
  const [slug] = need(a, 1, "map entry add <map> --name N …");
  if (!o.name) throw new CliFail("map entry add needs --name");
  const e = await api<Entry>("POST", `${mapPath(slug)}/entries`, entryFields() as EntryCreate);
  if (o.json) return emit(e);
  console.log(`created ${entryLine(e)}`);
};

const entrySet: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map entry set <map> <id> …");
  const patch = entryFields();
  if (!Object.keys(patch).length) throw new CliFail("map entry set: nothing to change");
  const e = await api<EntryWritten>("PATCH", entryPath(slug, id), patch);
  if (o.json) return emit(e);
  console.log(`updated ${entryLine(e)}\nundo: trip map entry restore ${slug} ${id} --rev ${e.undo_rev}`);
};

const entryRm: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map entry rm <map> <id>");
  const e = await api<EntryWritten>("DELETE", entryPath(slug, id));
  if (o.json) return emit(e);
  console.log(`deleted ${entryLine(e)}\nundo: trip map entry restore ${slug} ${id}`);
};

const entryPurge: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map entry purge <map> <id>");
  await api<void>("DELETE", `${entryPath(slug, id)}/purge`);
  if (o.json) return emit({ purged: Number(id) });
  console.log(`purged entry ${id} on ${slug}`);
};

const entryRestore: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map entry restore <map> <id> [--rev N]");
  const body = o.rev === undefined ? {} : { rev: num("rev", o.rev) };
  const e = await api<Entry>("POST", `${entryPath(slug, id)}/restore`, body);
  if (o.json) return emit(e);
  console.log(`restored ${entryLine(e)}`);
};

const entryHistory: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map entry history <map> <id>");
  const revs = await api<EntryRev[]>("GET", `${entryPath(slug, id)}/history`);
  if (o.json) return emit(revs);
  for (const r of revs)
    console.log(`${String(r.id).padStart(5)} ${r.at}  ${r.action.padEnd(7)} ${r.by ?? "-"}  ${r.snapshot.name}`);
};

const AVATAR_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const entryAvatar: Handler = async (a) => {
  const [slug, id, file] = need(a, 2, "map entry avatar <map> <id> (<file> | --clear)");
  if (o.clear) {
    await api("DELETE", `${entryPath(slug, id)}/avatar`);
    console.log(`cleared the picture of entry ${id}`);
    return;
  }
  if (!file) throw new CliFail("map entry avatar needs a file or --clear");
  const type = AVATAR_TYPES[file.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!type) throw new CliFail(`${file}: use a .jpg, .png or .webp`);
  const url = o.url ?? process.env.TRIP_URL;
  if (!url) throw new CliFail("no server: set TRIP_URL or pass --url");
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}${entryPath(slug, id)}/avatar`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await adminToken()}`, "Content-Type": type },
    body: readFileSync(file),
  });
  if (!res.ok)
    throw new CliFail(
      `PUT avatar: ${res.status} ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText}`,
    );
  const e = (await res.json()) as EntryWritten;
  if (o.json) return emit(e);
  console.log(`picture ${e.avatar} on ${entryLine(e)}\nundo: trip map entry restore ${slug} ${id} --rev ${e.undo_rev}`);
};

const hours = (m: number | null) => (m == null ? "-" : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);

function printMeet(s: MeetState) {
  console.log(
    `${s.members.length} members${s.centroid ? `, middle ${s.centroid.lat},${s.centroid.lon}` : ""}${s.stale ? ", result out of date" : ""}`,
  );
  if (s.job) console.log(s.job.error ? `job failed: ${s.job.error}` : `job running: ${s.job.done}/${s.job.total}`);
  const r = s.result;
  if (!r) return;
  console.log(`computed ${r.computed_at}, trains for ${r.departure}${r.train_ok ? "" : ", TRAIN SERVICE DOWN"}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const [i, c] of r.candidates.entries()) {
    console.log(`${i + 1}. ${c.station.name}  mean ${hours(c.mean_min)}  longest ${hours(c.max_min)}`);
    for (const l of c.legs) {
      const who = r.based_on.find((b) => b.entry_id === l.entry_id)?.name ?? l.entry_id;
      console.log(
        `   ${hours(l.minutes).padStart(5)} ${l.by.padEnd(12)} ${who}${l.station ? `  ab ${l.station}${l.access_min ? `, +${hours(l.access_min)}` : ""}` : ""}`,
      );
    }
  }
}

const meetPath = (slug: string) => `${mapPath(slug)}/meet`;

const meetShow: Handler = async (a) => {
  const [slug] = need(a, 1, "map meet <map>");
  const s = await api<MeetState>("GET", meetPath(slug));
  if (o.json) return emit(s);
  printMeet(s);
};

const meetSet: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map meet set <map> <entryId> …");
  const body: MeetMemberPut = {};
  if (o.weight !== undefined) body.weight = num("weight", o.weight);
  if (o.mode !== undefined) body.mode = o.mode as MeetMemberPut["mode"];
  if (o.place !== undefined) body.place_id = o.place[0];
  const s = await api<MeetState>("PUT", `${meetPath(slug)}/members/${encodeURIComponent(id)}`, body);
  if (o.json) return emit(s);
  console.log(`${s.members.length} members, result ${s.stale ? "out of date" : "current"}`);
};

const meetRm: Handler = async (a) => {
  const [slug, id] = need(a, 2, "map meet rm <map> <entryId>");
  const s = await api<MeetState>("DELETE", `${meetPath(slug)}/members/${encodeURIComponent(id)}`);
  console.log(`${s.members.length} members`);
};

const meetCompute: Handler = async (a) => {
  const [slug] = need(a, 1, "map meet compute <map> [--wait]");
  let s = await api<MeetState>("POST", `${meetPath(slug)}/compute`);
  while (o.wait && s.job && !s.job.error) {
    await Bun.sleep(2000);
    s = await api<MeetState>("GET", meetPath(slug));
  }
  if (o.json) return emit(s);
  printMeet(s);
};

const meetSub: Record<string, Handler> = { set: meetSet, rm: meetRm, compute: meetCompute };

const mapSub: Record<string, Handler> = {
  ls: mapLs,
  new: mapNew,
  show: mapShow,
  set: mapSet,
  rm: mapRm,
  links: mapLinks,
  share: mapShare,
  geocode: mapGeocode,
};
const entrySub: Record<string, Handler> = {
  add: entryAdd,
  set: entrySet,
  rm: entryRm,
  purge: entryPurge,
  restore: entryRestore,
  history: entryHistory,
  avatar: entryAvatar,
};

// ═══ dispatch ═════════════════════════════════════════════════════════════

const sub: Record<string, Record<string, Handler>> = {
  days: { import: daysImport, "import-gpx": daysImportGpx, rm: daysRm },
  media: { attach: mediaAttach, rm: mediaRm, order: mediaOrder, suggest: mediaSuggest },
};
const noteSub: Record<string, Handler> = { set: noteSet, add: noteAdd, mv: noteMv, rm: noteRm };
const top: Record<string, Handler> = { ls: trips, new: newTrip, show, set: setTrip, links, share, export: exportTrip };

async function main() {
  const [cmd, ...rest] = pos;
  if (o.help || !cmd) {
    console.log(USAGE);
    return;
  }
  if (cmd === "note") {
    const h = noteSub[rest[0] ?? ""];
    return h ? h(rest.slice(1)) : noteShow(rest);
  }
  if (cmd === "map" && rest[0] === "meet") {
    const h = meetSub[rest[1] ?? ""];
    return h ? h(rest.slice(2)) : meetShow(rest.slice(1));
  }
  if (cmd === "map") {
    const nested = rest[0] === "entry";
    const h = nested ? entrySub[rest[1] ?? ""] : mapSub[rest[0] ?? ""];
    if (!h)
      throw new CliFail(
        `usage: trip map ${nested ? `entry ${Object.keys(entrySub).join("|")}` : `${Object.keys(mapSub).join("|")}|entry`} …`,
      );
    return h(rest.slice(nested ? 2 : 1));
  }
  const group = sub[cmd];
  if (group) {
    const h = group[rest[0] ?? ""];
    if (!h) throw new CliFail(`usage: trip ${cmd} ${Object.keys(group).join("|")} …`);
    return h(rest.slice(1));
  }
  const h = top[cmd];
  if (!h) throw new CliFail(`unknown command '${cmd}'\n${USAGE}`);
  return h(rest);
}

try {
  await main();
} catch (err) {
  console.error(`trip: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
