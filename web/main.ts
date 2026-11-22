// The page: one selection keeps strip, map and sheet in step; back closes the topmost layer.
import "leaflet/dist/leaflet.css";
import "photoswipe/style.css";
import "./styles.css";
import * as L from "leaflet";
import type { Day, Note, TripView } from "../src/shared/api";
import { Api, ApiFailure } from "./api";
import { createEdit, type Edit } from "./edit";
import { createMap } from "./map";
import { createSheet, isDesktop, type Mode } from "./sheet";
import { createStrip } from "./strip";
import { $, icon, noteTitle, setDayOffset, setZone, toast } from "./util";
import { closeViewer, openViewer, viewerOpen } from "./viewer";

const token = location.pathname.split("/")[1] as string;
for (const k of Object.keys(localStorage)) if (k.startsWith("trip-edit:")) localStorage.removeItem(k);
const api = new Api(token);
let view = JSON.parse($("trip").textContent as string) as TripView;
// Editing is on where the server inlined the editable view: the editing host, behind the proxy's login.
const loggedIn = view.editable;
setZone(view.trip.timezone);
setDayOffset(view.trip.day_offset);

let byKey = new Map<string, { note: Note; idx: number }>();
let days = new Map<number, Day>();
let selected: string | null = null;
let edit: Edit | null = null;

// ---- history: each open layer (sheet, viewer) is one entry, so back closes it instead of leaving
const layers: (() => void)[] = [];
let ignorePops = 0;
function pushLayer(closer: () => void) {
  history.pushState({ layer: layers.length + 1 }, "");
  layers.push(closer);
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
    ignorePops--;
    return;
  }
  layers.pop()?.();
});

// ---- the parts
const mapView = createMap($("map"));
const strip = createStrip($("strip"));
const sheet = createSheet($("sheet"), {
  prev: () => step(-1),
  next: () => step(1),
  close: () => close(),
  mode: (m) => (m === "closed" ? close() : setMode(m)),
  media: (i) => selected && showMedia(selected, i),
  action: (name) => {
    const n = selected ? byKey.get(selected)?.note : null;
    if (!n) return;
    if (name === "link") return shareNote(n);
    edit?.action(name, n);
  },
});

function index(v: TripView) {
  byKey = new Map(v.notes.map((note, idx) => [note.key, { note, idx }]));
  days = new Map(v.days.map((d) => [d.n, d]));
}

function apply(v: TripView) {
  view = v;
  setDayOffset(v.trip.day_offset);
  index(v);
  mapView.render(v);
  strip.render(v);
  if (selected && !byKey.has(selected)) close();
  else if (selected) renderSheet();
}

async function refresh(): Promise<void> {
  try {
    const v = await api.view();
    if (v) apply(v);
  } catch (e) {
    if (!(e instanceof ApiFailure)) return;
    toast(`Aktualisieren fehlgeschlagen: ${e.message}`, 4000);
  }
}

// ---- selection
const noteDay = (n: Note) => (n.kind === "day" ? n.day : n.anchor.day);

function renderSheet() {
  const it = selected ? byKey.get(selected) : undefined;
  if (!it) return;
  const n = it.note;
  sheet.render(n, n.day == null ? undefined : days.get(n.day), {
    first: it.idx === 0,
    last: it.idx === view.notes.length - 1,
    editable: edit != null,
  });
}

function select(key: string, mode: Mode = "half") {
  const it = byKey.get(key);
  if (!it) return;
  const wasClosed = sheet.mode() === "closed";
  selected = key;
  mapView.select(key, noteDay(it.note));
  strip.select(key);
  renderSheet();
  setMode(isDesktop() && mode === "peek" ? "half" : mode);
  if (wasClosed) pushLayer(() => close(true));
  history.replaceState(history.state, "", noteUrl(key));
}

function setMode(m: Mode) {
  sheet.setMode(m);
  const it = selected ? byKey.get(selected) : undefined;
  if (it && m !== "closed") ensureVisible(it.note);
}

function close(fromHistory = false) {
  if (!selected) return;
  selected = null;
  mapView.select(null, null);
  strip.select(null);
  sheet.setMode("closed");
  history.replaceState(history.state, "", noteUrl(null));
  if (!fromHistory) dropLayer();
}

function tap(key: string) {
  if (key !== selected) return select(key, sheet.mode() === "full" ? "full" : "half");
  // The selected note again: hide the sheet to free the map, or bring it back.
  if (isDesktop()) return;
  setMode(sheet.mode() === "peek" ? "half" : "peek");
}

function step(k: number) {
  const it = selected ? byKey.get(selected) : undefined;
  const next = it ? view.notes[it.idx + k] : view.notes[0];
  if (next) select(next.key, sheet.mode() === "full" ? "full" : "half");
}

/** The part of the map nothing covers: below the strip, above the sheet, left of the desktop panel. */
function band() {
  const open = sheet.mode() !== "closed";
  const r = sheet.el.getBoundingClientRect();
  return {
    top: strip.bottom(),
    left: 0,
    right: open && isDesktop() ? r.left : innerWidth,
    bottom: open && !isDesktop() ? r.top : innerHeight,
  };
}

/** Selecting moves the map only when the pin is outside the free band; the zoom stays. */
function ensureVisible(n: Note) {
  if (n.lat == null || n.lon == null) return;
  const b = band();
  if (b.bottom - b.top < 80) return;
  const p = mapView.map.latLngToContainerPoint([n.lat, n.lon]);
  const m = 28;
  if (p.x > b.left + m && p.x < b.right - m && p.y > b.top + m + 24 && p.y < b.bottom - m) return;
  mapView.map.panBy([p.x - (b.left + b.right) / 2, p.y - (b.top + b.bottom) / 2 - 14], {
    animate: true,
    duration: 0.25,
  });
}

function fitAll() {
  const open = sheet.mode() !== "closed" && isDesktop();
  mapView.fitAll(strip.bottom(), open ? innerWidth - sheet.el.getBoundingClientRect().left : 0);
}

// ---- media viewer
function showMedia(key: string, i: number) {
  sheet.pausePlayback();
  let fromHistory = false;
  openViewer({
    notes: view.notes,
    key,
    index: i,
    editable: edit != null,
    onClose: (owner) => {
      if (!fromHistory) dropLayer();
      if (owner !== selected) select(owner, sheet.mode() === "full" ? "full" : "half");
    },
    onCaption: edit ? (n, m) => (edit as Edit).caption(n, m) : undefined,
    onRemove: edit ? (n, m) => (edit as Edit).remove(n, m) : undefined,
  });
  pushLayer(() => {
    fromHistory = true;
    closeViewer();
  });
}

// ---- links
function noteUrl(key: string | null) {
  return location.pathname + (key ? `?n=${key}` : "");
}

/** The link others get: the friends' link for an editor (whose own token is never handed out), else this page's. */
function readLink(key: string | null): string | null {
  const base = edit ? view.share_url : location.origin + location.pathname;
  return base ? base + (key ? `?n=${key}` : "") : null;
}

async function shareLink(url: string, title: string) {
  if (navigator.share) return navigator.share({ title, url }).catch(() => {});
  await navigator.clipboard.writeText(url).catch(() => {});
  toast("Link kopiert");
}

function shareNote(n: Note) {
  const url = readLink(n.key);
  if (!url) return toast("Es gibt noch keinen Link für Freunde.", 4000);
  return shareLink(url, `${noteTitle(n, n.day == null ? undefined : days.get(n.day))} – ${view.trip.title}`);
}

// ---- where am I
let me: L.LatLng | null = null;
function locate(pan: boolean): Promise<L.LatLng | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        me = L.latLng(p.coords.latitude, p.coords.longitude);
        mapView.showMe(me, p.coords.accuracy);
        if (pan) mapView.map.setView(me, Math.max(mapView.map.getZoom(), 14));
        resolve(me);
      },
      (e) => {
        toast(`Kein Standort: ${e.message}`, 4000);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

// ---- buttons on the map
function fabs() {
  const el = $("fabs");
  const b = (id: string, ic: string, title: string, cls = "fab s") =>
    `<button class="${cls}" id="${id}" title="${title}" aria-label="${title}">${ic}</button>`;
  el.innerHTML =
    b("fit", icon.fit, "Ganze Reise") +
    b("locate", icon.locate, "Wo bin ich") +
    (edit ? b("share", icon.friends, "Link für Freunde") + b("add", icon.plus, "Notiz setzen", "fab") : "");
  $("fit").onclick = () => {
    close();
    fitAll();
  };
  $("locate").onclick = () => void locate(true);
  if (edit) {
    $("share").onclick = () => {
      const url = readLink(null);
      if (!url) return toast("Es gibt noch keinen Link für Freunde.", 4000);
      return shareLink(url, view.trip.title);
    };
    $("add").onclick = () => edit?.togglePlacing();
  }
}

// ---- wiring
mapView.onPin((key) => (edit?.placing() ? undefined : tap(key)));
mapView.onTap((at) => {
  if (edit?.mapTap(at)) return;
  if (selected) close();
});
strip.onTap((key) => tap(key));
strip.onTrip(() => {
  close();
  fitAll();
});

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (viewerOpen() || document.body.classList.contains("editing") || document.body.classList.contains("picking"))
    return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea")) return;
  // The space bar plays and pauses the open note's video, unless a button holds the focus.
  if (e.key === " " && selected && !t.closest("button, a, summary") && sheet.togglePlayback()) e.preventDefault();
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft" && selected) step(-1);
  else if (e.key === "Escape") close();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

new ResizeObserver(() => document.documentElement.style.setProperty("--strip-h", `${strip.bottom()}px`)).observe(
  $("strip"),
);

function enableEdit() {
  edit = createEdit({
    api,
    refresh,
    expired,
    select: (key) => select(key),
    close: () => close(),
    setPlacing: (on) => mapView.setPlacing(on),
    locate: () => (me ? Promise.resolve(me) : locate(false)),
    nextNumber: () => Math.max(0, ...view.notes.map((n) => n.number ?? 0)) + 1,
    pending: (list) => mapView.setPending(list),
    zone: view.trip.timezone,
    pushLayer,
    dropLayer,
  });
  document.body.classList.add("can-edit");
}

// ---- start
index(view);
mapView.render(view);
strip.render(view);
document.documentElement.style.setProperty("--strip-h", `${strip.bottom()}px`);
fitAll();
fabs();
const initial = new URLSearchParams(location.search).get("n");
if (initial && byKey.has(initial)) select(initial);

// ---- edit mode: the owner's session
/** The login ran out: the badge becomes the way back in (a reload runs the proxy's login again). Queued placements and drafts stay on the device. */
let expiredShown = false;
function expired() {
  if (expiredShown) return;
  expiredShown = true;
  const b = $("edit-badge");
  b.hidden = false;
  b.textContent = "Anmelden";
  b.onclick = () => location.reload();
  toast("Anmeldung abgelaufen – zum Anmelden auf „Anmelden“ tippen. Wartendes bleibt auf dem Gerät.", 8000);
}

function editBadge() {
  const b = $("edit-badge");
  b.hidden = false;
  b.onclick = () => $("edit-menu").classList.toggle("show");
  $<HTMLAnchorElement>("edit-settings").href = `/trips/${encodeURIComponent(view.trip.slug)}`;
  $("edit-stop").onclick = () => location.assign(view.sign_out_path as string);
}

if (loggedIn) {
  api
    .view()
    .then((v) => {
      if (v && !v.editable) return expired();
      enableEdit();
      editBadge();
      if (v) apply(v);
      else renderSheet();
      fabs();
    })
    .catch((e) => {
      if (e instanceof ApiFailure) return toast(`Bearbeiten nicht möglich: ${e.message}`, 5000);
      // No network: trust the marker; placements wait on the device until it is back.
      enableEdit();
      editBadge();
      renderSheet();
      fabs();
      toast("Ohne Netz – neue Notizen warten auf dem Gerät.", 5000);
    });
}

// Exposed for the self-test.
Object.assign(window, {
  trip: {
    state: () => ({
      selected,
      mode: sheet.mode(),
      zoom: mapView.map.getZoom(),
      center: mapView.map.getCenter(),
      layers: layers.length,
    }),
    keys: () => view.notes.map((n) => n.key),
    point: (lat: number, lon: number) => mapView.map.latLngToContainerPoint([lat, lon]),
    setView: (lat: number, lon: number, zoom: number) => mapView.map.setView([lat, lon], zoom, { animate: false }),
    band,
    pinPoints: () => mapView.pinPoints(),
  },
});
