// The map page: the list, the selected entry and the map stay in step; back closes the topmost layer.
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import type { Entry, EntryWritten, GeoHit, MapView, MeetMode, MeetState } from "../../src/shared/api";
import { ApiFailure, failureText, MapApi } from "./api";
import { avatarBody, squareJpeg } from "./avatar";
import { createForm, type Seed } from "./form";
import { createMap, type MapEvents, noMap, type PeopleMap } from "./map";
import { meetBody, meetHead } from "./meet";
import { type Addresses, createSearch, matchEntries } from "./search";
import {
  addressBody,
  addressHead,
  cardBody,
  cardHead,
  createSheet,
  emptyHtml,
  entriesHtml,
  groupHead,
  hitRow,
  isDesktop,
  listHead,
  type Mode,
  pickBody,
  pickHead,
  sortEntries,
  trashSection,
} from "./sheet";
import { $, icon, lastGrapheme, setPictures, shareLink, toast } from "./util";

const POLL_MS = 20_000;
const JOB_POLL_MS = 2000;
const ADDRESS_ZOOM = 16;
const PLACE_ZOOM = 15;
const LOCATE_ZOOM = 11;

type Hit = Pick<GeoHit, "label" | "lat" | "lon">;
type Pane =
  | { kind: "list" }
  | { kind: "card"; id: number }
  | { kind: "address"; hit: Hit; title: string; pending: boolean }
  | { kind: "pick"; hit: Hit }
  | { kind: "group"; ids: number[]; at: { lat: number; lon: number } }
  | { kind: "meet"; selected: number }
  | { kind: "avatar"; id: number; picture: Blob | null; preview: string | null };

const token = location.pathname.split("/")[2] as string;
const api = new MapApi(token);
let view = JSON.parse($("data").textContent as string) as MapView;
const editable = view.editable;
setPictures(`/api/m/${token}`);

let pane: Pane = { kind: "list" };
let searching = false;
let query = "";
let addresses: Addresses = { state: "idle" };
let me: { lat: number; lon: number } | null = null;
let near = false;
let trashOpen = false;
let moving = false;

// ---- history: each open layer (card, search, form, moving) is one entry, so back closes it
const layers: (() => void)[] = [];
let ignorePops = 0;
let waitingPushes = 0;
function pushLayer(closer: () => void) {
  layers.push(closer);
  if (ignorePops) waitingPushes++;
  else history.pushState({ layer: layers.length }, "");
}
/** The layer was closed in the UI: drop its history entry without running its closer. */
function dropLayer() {
  if (!layers.length) return;
  layers.pop();
  ignorePops++;
  history.back();
}
addEventListener("popstate", () => {
  if (ignorePops) {
    if (--ignorePops === 0)
      for (; waitingPushes > 0; waitingPushes--) history.pushState({ layer: layers.length - waitingPushes + 1 }, "");
    syncUrl();
    return;
  }
  layers.pop()?.();
  syncUrl();
});

function syncUrl() {
  const q = pane.kind === "card" ? `?e=${pane.id}` : "";
  history.replaceState(history.state, "", location.pathname + q);
}

// ---- the parts
function free() {
  if (moving) return { top: 100, bottom: 120, left: 30, right: 30 };
  const top = (isDesktop() ? 0 : $("search").getBoundingClientRect().bottom) + 16;
  const sab = $("sab-probe").getBoundingClientRect().height;
  return isDesktop()
    ? { top: 40, bottom: 40, left: 90, right: innerWidth - sheet.el.getBoundingClientRect().left + 24 }
    : { top, bottom: sheet.height() + sab + 16, left: 30, right: 70 };
}

const mapEvents: MapEvents = {
  pin: (id) => openEntry(id, false),
  group: (ids, at) => setPane({ kind: "group", ids, at }, "half"),
  tap: () => {
    if (searching) closeSearch();
    else if (pane.kind !== "list") closePane();
    else sheet.setMode("peek");
  },
  hold: (lat, lon) => void holdAt(lat, lon),
  star: (rank) => {
    if (pane.kind === "meet") pane.selected = rank;
    showMeet();
    render(false);
  },
  padding: () => free(),
  failed: () => {
    if (!tilesFailed) toast("Die Karte lädt gerade nicht vollständig.");
    tilesFailed = true;
  },
};
let tilesFailed = false;
let mapView: PeopleMap;
try {
  mapView = createMap($("map"), mapEvents);
} catch {
  mapView = noMap();
}

const sheet = createSheet($("sheet"), {
  mode: (m) => setMode(m),
  action: (name, data) => act(name, data),
});

const search = createSearch($("search"), api, {
  open: openSearch,
  change(q, a) {
    query = q;
    addresses = a;
    render(false);
  },
  close: closeSearch,
  locate: () => void locate(true),
  near: () => me,
});

const form = createForm($("form"), {
  api,
  token,
  locate: () => locate(false),
  move: moveOnMap,
  cancelled: () => closeForm(),
  saved(e, undo, revived) {
    // The answer is newer than the view: the card must not see the entry as gone.
    view = { ...view, entries: [...view.entries.filter((x) => x.id !== e.id), e] };
    closeForm();
    void refresh().then(() => openEntry(e.id, true));
    const undoIt = undo == null ? undefined : () => void restore(e.id, undo);
    toast(revived ? `${e.name} ist wieder da` : `${e.name} gespeichert`, undoIt);
  },
});

// ---- rendering
function entry(id: number): Entry | undefined {
  return view.entries.find((e) => e.id === id);
}

function listBody(): string {
  const rows = sortEntries(view.entries, me, near);
  if (!rows.length && !view.trash.length) return emptyHtml(editable);
  return entriesHtml(rows, me, editable) + trashSection(view.trash, trashOpen, view.can_purge);
}

function searchBody(): string {
  const people = sortEntries(matchEntries(view.entries, query), me, near);
  const list = entriesHtml(people, me, editable);
  const a = addresses;
  let found = "";
  if (a.state === "loading")
    found = `<p class="hint searching" role="status"><span class="spin" aria-hidden="true"></span>Sucht…</p>`;
  else if (a.state === "down") found = `<p class="hint">Adresssuche gerade nicht erreichbar.</p>`;
  else if (a.state === "hits")
    found = a.hits.length ? a.hits.map(hitRow).join("") : `<p class="hint">Keine Adresse gefunden.</p>`;
  const none = query.trim() && !people.length && !found ? `<p class="hint">Niemand mit diesem Namen.</p>` : "";
  return `${list}${none}${found ? `<h3>Adressen</h3>${found}` : ""}<div class="keyboard-room"></div>`;
}

function render(top: boolean) {
  document.body.classList.toggle("searching", searching);
  if (searching) {
    sheet.setHead("");
    sheet.setBody(searchBody(), top);
    return;
  }
  if (pane.kind === "list") {
    sheet.setHead(listHead(view, { available: me != null, on: near }));
    sheet.setBody(listBody(), top);
  } else if (pane.kind === "meet") {
    sheet.setHead(meetHead());
    sheet.setBody(meetBody(view.meet, view.entries, pane.selected, middleName, editable), top);
  } else if (pane.kind === "avatar") {
    const e = entry(pane.id) as Entry;
    sheet.setHead(addressHead(`Bild für ${e.name}`));
    sheet.setBody(avatarBody(e, pane.preview), top);
  } else if (pane.kind === "card") {
    const e = entry(pane.id) as Entry;
    sheet.setHead(cardHead(e, editable));
    sheet.setBody(cardBody(e, me, editable), top);
  } else if (pane.kind === "address") {
    sheet.setHead(addressHead(pane.title));
    sheet.setBody(addressBody(pane.hit, editable, pane.pending), top);
  } else if (pane.kind === "pick") {
    sheet.setHead(pickHead());
    sheet.setBody(pickBody(view.entries), top);
  } else {
    sheet.setHead(groupHead(pane.ids.length));
    const rows = pane.ids.flatMap((id) => entry(id) ?? []);
    sheet.setBody(entriesHtml(rows, me, editable), top);
  }
}

function apply(v: MapView) {
  view = v;
  mapView.setEntries(v.entries);
  // The card behind an open form shows what changed when the form closes.
  if (form.isOpen() || moving) return form.absorb(v.entries);
  if ((pane.kind === "card" || pane.kind === "avatar") && !entry(pane.id)) {
    toast("Dieser Eintrag wurde gerade gelöscht.");
    closePane();
    return;
  }
  followJob();
  if (pane.kind === "meet") {
    showMeet();
    void nameMiddle();
    const at = v.meet.result?.computed_at;
    if (at !== fittedResult) keepInView();
    fittedResult = at;
  }
  // The emoji field keeps its text and its keyboard.
  if (pane.kind !== "avatar") render(false);
}

let linkGone = false;

async function refresh(): Promise<void> {
  try {
    const v = await api.view();
    if (v) apply(v);
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404 && !linkGone) toast("Dieser Link gilt nicht mehr.");
    linkGone = e instanceof ApiFailure && e.status === 404;
  }
}

// ---- panes
function setMode(m: Mode) {
  sheet.setMode(m);
  keepInView();
}

/** What the open pane is about, on the map. */
function focusPoints(): { lat: number; lon: number }[] {
  if (pane.kind === "card") return entry(pane.id)?.places ?? [];
  if (pane.kind === "group") return [pane.at];
  if (pane.kind === "address") return [pane.hit];
  if (pane.kind === "meet") {
    const r = view.meet.result;
    return r && !view.meet.stale ? [...r.based_on, ...r.candidates.map((c) => c.station)] : [];
  }
  return [];
}

/** That goes where the sheet and the pill do not cover it; the zoom stays. */
function keepInView() {
  const points = focusPoints();
  const f = free();
  const inside = points.every((p) => {
    const at = mapView.point(p.lat, p.lon);
    return at.x > f.left && at.x < innerWidth - f.right && at.y > f.top + 48 && at.y < innerHeight - f.bottom;
  });
  if (!inside) mapView.show(points, f);
}

function setPane(p: Pane, mode: Mode) {
  const fromList = pane.kind === "list";
  const fromSearch = searching;
  if (searching) endSearch();
  if (pane.kind === "address" || pane.kind === "pick") mapView.setTemp(null);
  pane = p;
  mapView.select(p.kind === "card" ? p.id : null);
  if (p.kind === "address" || p.kind === "pick") mapView.setTemp(p.hit);
  if (p.kind === "meet") showMeet();
  else mapView.setMeet(null);
  render(true);
  sheet.setMode(mode);
  // The search's history entry goes on as the pane's.
  if (fromSearch) layers[layers.length - 1] = () => closePane(true);
  else if (fromList && p.kind !== "list") pushLayer(() => closePane(true));
  keepInView();
  syncUrl();
}

function closePane(fromHistory = false) {
  if (pane.kind === "list") return;
  mapView.setTemp(null);
  mapView.select(null);
  mapView.setMeet(null);
  pane = { kind: "list" };
  render(true);
  sheet.setMode("peek");
  if (!fromHistory) dropLayer();
  syncUrl();
}

function openEntry(id: number, fromSave: boolean) {
  if (!entry(id)) return;
  setPane({ kind: "card", id }, fromSave || isDesktop() ? "half" : sheet.mode() === "full" ? "full" : "half");
}

function step(k: number) {
  const rows = sortEntries(view.entries, me, near);
  const at = pane.kind === "card" ? rows.findIndex((e) => e.id === (pane as { id: number }).id) : -1;
  const next = rows[at + k];
  if (next) openEntry(next.id, false);
}

// ---- the meeting point
let fittedResult: string | undefined;
let middleName: string | null = null;
let middleOf = "";

/** The town at the straight-line middle, through the address search and its cache. */
async function nameMiddle() {
  const m = view.meet.centroid;
  const key = m ? `${m.lat.toFixed(2)},${m.lon.toFixed(2)}` : "";
  if (key === middleOf) return;
  middleOf = key;
  middleName = null;
  if (!m) return;
  const hits = await api.reverse(Number(m.lat.toFixed(2)), Number(m.lon.toFixed(2))).catch(() => []);
  middleName = hits[0]?.city ?? null;
  if (pane.kind === "meet") render(false);
}

function showMeet() {
  if (pane.kind !== "meet") return;
  const rank = pane.selected;
  const { members, result, centroid } = view.meet;
  const c = result?.candidates;
  const best = c?.[rank]?.station ?? c?.[0]?.station;
  const place = (m: (typeof members)[number]) => {
    const places = entry(m.entry_id)?.places ?? [];
    return places.find((p) => p.id === m.place_id) ?? places[0];
  };
  mapView.setMeet({
    middle: centroid,
    stars: (c ?? []).map((x, i) => ({ lat: x.station.lat, lon: x.station.lon, selected: i === rank })),
    lines: best
      ? members.flatMap((m) => {
          const from = place(m);
          return from ? [{ from, to: best, train: m.mode === "train" }] : [];
        })
      : [],
    members: new Set(members.map((m) => m.entry_id)),
  });
}

function openMeet() {
  fittedResult = view.meet.result?.computed_at;
  setPane({ kind: "meet", selected: 0 }, "half");
  followJob();
  void nameMiddle();
}

let jobTimer: ReturnType<typeof setTimeout> | undefined;

/** While a job runs anywhere, this page follows it closely; afterwards the poll takes over. */
function followJob() {
  const job = view.meet.job;
  if (jobTimer || !job || job.error) return;
  jobTimer = setTimeout(async () => {
    jobTimer = undefined;
    const state = await api.meet().catch(() => null);
    if (!state) return followJob();
    const finished = !state.job;
    view = { ...view, meet: state };
    if (finished) await refresh();
    else if (pane.kind === "meet" && !form.isOpen()) render(false);
    followJob();
  }, JOB_POLL_MS);
}

/** One tap on the selection: the answer is everybody's new state. */
async function meetWrite(call: Promise<MeetState>) {
  try {
    view = { ...view, meet: await call };
    followJob();
    showMeet();
    render(false);
    void nameMiddle();
  } catch (err) {
    toast(err instanceof ApiFailure && err.status === 409 ? err.message : failureText(err));
  }
}

// ---- pictures
const by = () => localStorage.getItem("map-by");

function pictureDone(e: EntryWritten, text: string) {
  view = { ...view, entries: view.entries.map((x) => (x.id === e.id ? e : x)) };
  mapView.setEntries(view.entries);
  setPane({ kind: "card", id: e.id }, "half");
  toast(text, () => void restore(e.id, e.undo_rev));
}

async function pictureChosen(file: File) {
  if (pane.kind !== "avatar") return;
  try {
    const picture = await squareJpeg(file);
    if (pane.kind !== "avatar") return;
    pane.picture = picture;
    pane.preview = URL.createObjectURL(picture);
    render(true);
  } catch {
    toast("Dieses Bildformat kann der Browser nicht lesen.");
  }
}

function dropPreview() {
  if (pane.kind !== "avatar" || !pane.preview) return;
  URL.revokeObjectURL(pane.preview);
  pane.preview = null;
  pane.picture = null;
}

async function pictureWrite(call: () => Promise<EntryWritten>, text: string) {
  try {
    pictureDone(await call(), text);
  } catch (err) {
    toast(failureText(err));
  }
}

// ---- search
function openSearch() {
  if (searching) return;
  if (pane.kind !== "list") closePane();
  searching = true;
  query = "";
  addresses = { state: "idle" };
  search.setOpen(true);
  render(true);
  sheet.setMode("full");
  pushLayer(() => closeSearch(true));
}

function endSearch() {
  searching = false;
  search.reset();
  search.setOpen(false);
}

function closeSearch(viaHistory = false) {
  if (!searching) return;
  endSearch();
  render(true);
  sheet.setMode("peek");
  scrollTo(0, 0);
  if (!viaHistory) dropLayer();
}

function openHit(h: GeoHit) {
  setPane({ kind: "address", hit: h, title: "Adresse", pending: false }, "half");
  mapView.flyTo(h.lat, h.lon, ADDRESS_ZOOM);
}

async function holdAt(lat: number, lon: number) {
  const hit: Hit = { label: "", lat, lon };
  setPane({ kind: "address", hit, title: "Dieser Punkt", pending: true }, "half");
  const hits = await api.reverse(lat, lon).catch(() => []);
  if (pane.kind !== "address" || pane.hit !== hit) return;
  hit.label = hits[0]?.label ?? "";
  pane.pending = false;
  render(false);
}

// ---- editing
function openForm(seed: Seed) {
  form.open(seed);
  pushLayer(() => {
    form.hide();
    apply(view);
  });
}

function closeForm() {
  form.hide();
  dropLayer();
  apply(view);
}

async function remove(id: number) {
  const e = entry(id);
  if (!e) return;
  try {
    const gone = await api.remove(id, localStorage.getItem("map-by"));
    if (pane.kind === "card") closePane();
    await refresh();
    toast(`${e.name} gelöscht`, () => void restore(id, gone.undo_rev));
  } catch (err) {
    toast(failureText(err));
  }
}

async function purge(id: number) {
  const e = view.trash.find((x) => x.id === id);
  if (!e || !confirm(`${e.name} endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
  try {
    await api.purge(id);
    await refresh();
    toast(`${e.name} ist endgültig gelöscht`);
  } catch (err) {
    toast(failureText(err));
  }
}

async function restore(id: number, rev?: number) {
  try {
    const e = await api.restore(id, { ...(rev == null ? {} : { rev }), by: localStorage.getItem("map-by") });
    await refresh();
    toast(rev == null ? `${e.name} ist wieder da` : "Rückgängig gemacht");
  } catch (err) {
    toast(failureText(err));
  }
}

/** Moving a place: the map alone, with one draggable pin and a bar with Fertig. */
function moveOnMap(at: { lat: number; lon: number } | null) {
  return new Promise<{ lat: number; lon: number } | null>((done) => {
    if (!mapView.live) {
      toast("Die Karte lässt sich hier nicht anzeigen.");
      return done(null);
    }
    const start = at ?? mapView.center();
    form.hide();
    moving = true;
    document.body.classList.add("moving");
    $("move-bar").hidden = false;
    sheet.hide(true);
    mapView.startMove(start);
    if (at) mapView.flyTo(at.lat, at.lon, Math.max(mapView.zoom(), PLACE_ZOOM));
    const finish = (save: boolean, viaHistory: boolean) => {
      const end = mapView.stopMove();
      moving = false;
      document.body.classList.remove("moving");
      $("move-bar").hidden = true;
      sheet.hide(false);
      if (!viaHistory) dropLayer();
      form.show();
      done(save ? end : null);
    };
    pushLayer(() => finish(false, true));
    $("move-done").onclick = () => finish(true, false);
    $("move-cancel").onclick = () => finish(false, false);
  });
}

function act(name: string, data: DOMStringMap) {
  const id = Number(data.id);
  if (name === "open") return openEntry(id, false);
  if (name === "close") {
    if (pane.kind !== "avatar") return closePane();
    dropPreview();
    return setPane({ kind: "card", id: pane.id }, "half");
  }
  if (name === "meet-pick" && pane.kind === "meet") {
    pane.selected = Number(data.i);
    showMeet();
    return render(false);
  }
  if (name === "near") {
    near = !near;
    return render(true);
  }
  if (name === "trash") {
    trashOpen = !trashOpen;
    return render(false);
  }
  if (name === "fly") return mapView.flyTo(Number(data.lat), Number(data.lon), PLACE_ZOOM);
  if (name === "link") {
    const base = view.view_url ?? (editable ? null : location.origin + location.pathname);
    if (!base) return toast("Es gibt noch keinen Link zum Ansehen.");
    return void shareLink(`${base}?e=${id}`, entry(id)?.name ?? view.map.title);
  }
  if (name === "hit" && addresses.state === "hits") {
    const h = addresses.hits[Number(data.i)];
    if (h) openHit(h);
    return;
  }
  if (!editable) return;
  if (name === "meet-toggle") {
    const m = view.meet.members.some((x) => x.entry_id === id);
    return void meetWrite(m ? api.deleteMember(id) : api.putMember(id, {}));
  }
  if (name === "meet-mode") return void meetWrite(api.putMember(id, { mode: data.mode as MeetMode }));
  if (name === "meet-weight") return void meetWrite(api.putMember(id, { weight: Number(data.w) }));
  if (name === "meet-compute") return void meetWrite(api.compute());
  if (name === "purge") return void purge(id);
  if (name === "avatar") return setPane({ kind: "avatar", id, picture: null, preview: null }, "half");
  if (pane.kind === "avatar") {
    const at = pane.id;
    if (name === "avatar-pick") return $("avatar-file").click();
    if (name === "avatar-drop") {
      dropPreview();
      return render(true);
    }
    if (name === "avatar-save" && pane.picture) {
      const picture = pane.picture;
      return void pictureWrite(() => api.putAvatar(at, picture, by()), "Bild gespeichert");
    }
    if (name === "avatar-emoji") {
      const emoji = lastGrapheme($<HTMLInputElement>("avatar-emoji").value.trim());
      if (!emoji) return toast("Erst ein Emoji eintippen.");
      return void pictureWrite(() => api.patch(at, { emoji, avatar: null, by: by() }), "Emoji gespeichert");
    }
    if (name === "avatar-clear")
      return void pictureWrite(() => api.patch(at, { emoji: null, avatar: null, by: by() }), "Nur noch Initialen");
  }
  if (name === "new") return openForm({});
  if (name === "edit") return openForm({ entry: entry(id) });
  if (name === "delete") return void remove(id);
  if (name === "undelete") return void restore(id);
  if (name === "add-place") return openForm({ entry: entry(id), focusPlace: true });
  if (name === "new-here" && pane.kind === "address") {
    const { label, lat, lon } = pane.hit;
    return openForm({ place: { address: label, lat, lon } });
  }
  if (name === "pick" && pane.kind === "address") return setPane({ kind: "pick", hit: pane.hit }, "full");
  if (name === "pick-entry" && pane.kind === "pick") {
    const { label, lat, lon } = pane.hit;
    return openForm({ entry: entry(id), place: { address: label, lat, lon } });
  }
}

// ---- where am I
function locate(pan: boolean): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      toast("Dieses Gerät gibt keinen Standort her.");
      return resolve(null);
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        me = { lat: p.coords.latitude, lon: p.coords.longitude };
        mapView.setMe(me);
        if (pan) mapView.flyTo(me.lat, me.lon, Math.max(mapView.zoom(), LOCATE_ZOOM));
        render(false);
        resolve(me);
      },
      () => {
        toast("Standort nicht verfügbar.");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

// ---- buttons on the map
function fabs() {
  const b = (id: string, ic: string, title: string, cls = "") =>
    `<button type="button" class="fab ${cls}" id="${id}" title="${title}" aria-label="${title}">${ic}</button>`;
  $("fabs").innerHTML =
    (view.meet_enabled ? b("meet", icon.meet, "Treffpunkt") : "") +
    b("fit", icon.fit, "Alle zeigen") +
    b("share", icon.share, "Link teilen") +
    (editable
      ? `<div class="share-menu" id="share-menu" hidden><button type="button" id="share-view">Link zum Ansehen</button><button type="button" id="share-edit">Link zum Bearbeiten<small>Wer ihn hat, kann alles ändern</small></button></div>${b("add", icon.plus, "Neuer Eintrag", "add")}`
      : "");
  $("fit").onclick = () => {
    if (pane.kind !== "list") closePane();
    mapView.fitAll(free(), true);
  };
  if (view.meet_enabled) $("meet").onclick = () => (pane.kind === "meet" ? closePane() : openMeet());
  const own = location.origin + location.pathname;
  if (!editable) {
    $("share").onclick = () => void shareLink(own, view.map.title);
    return;
  }
  const menu = $("share-menu");
  const shut = () => {
    menu.hidden = true;
    removeEventListener("pointerdown", outside, true);
  };
  const outside = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest("#share-menu, #share")) shut();
  };
  $("share").onclick = () => {
    if (!menu.hidden) return shut();
    menu.hidden = false;
    addEventListener("pointerdown", outside, true);
  };
  $("share-view").onclick = () => {
    shut();
    if (view.view_url) void shareLink(view.view_url, view.map.title);
    else toast("Es gibt noch keinen Link zum Ansehen.");
  };
  $("share-edit").onclick = () => {
    shut();
    void shareLink(own, view.map.title);
  };
  $("add").onclick = () => openForm({});
}

// ---- wiring
addEventListener("keydown", (e: KeyboardEvent) => {
  if (form.isOpen() || moving) return;
  const typing = (e.target as HTMLElement).closest("input, textarea");
  if (e.key === "Escape") {
    if (searching) closeSearch();
    else closePane();
  } else if (typing) return;
  else if (e.key === "/") {
    e.preventDefault();
    search.input.focus();
  } else if (e.key === "ArrowDown") step(1);
  else if (e.key === "ArrowUp") step(-1);
});

$<HTMLInputElement>("avatar-file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void pictureChosen(file);
  input.value = "";
});

$("sheet").addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.tagName === "SELECT" && editable) void meetWrite(api.putMember(Number(t.dataset.id), { place_id: t.value }));
});

// The keyboard goes away when the results are scrolled, so the whole list can be reached.
$("sheet").addEventListener("touchmove", () => {
  if (!searching) return;
  search.input.blur();
  scrollTo(0, 0);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
addEventListener("online", () => void refresh());
setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
}, POLL_MS);

// ---- start
$("badge").hidden = editable;
document.title = view.map.title;
fabs();
mapView.setEntries(view.entries);
render(true);
mapView.fitAll(free());
if (!mapView.live) {
  sheet.setMode("half");
  toast("Die Karte lässt sich hier nicht anzeigen, die Liste geht.");
}
followJob();
const initial = Number(new URLSearchParams(location.search).get("e"));
if (initial && entry(initial)) openEntry(initial, true);

// Exposed to the browser test only.
if (navigator.webdriver)
  Object.assign(window, {
    people: {
      map: mapView.debug(),
      markers: () => mapView.markers(),
      state: () => ({
        pane: pane.kind,
        mode: sheet.mode(),
        searching,
        layers: layers.length,
        zoom: mapView.zoom(),
      }),
      point: (lat: number, lon: number) => mapView.point(lat, lon),
      free,
    },
  });
