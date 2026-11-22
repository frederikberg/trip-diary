// The sheet under the map: a bottom sheet on phones (peek, half, full), a side panel on desktop. It
// shows one pane at a time; what is in it comes from the HTML helpers below.
import type { Entry, GeoHit, MapView, Place } from "../../src/shared/api";
import { googleMapsUrl, googleRouteUrl, streetViewUrl } from "../../src/shared/maplinks";
import { $, avatar, distance, esc, icon, kmBetween } from "./util";

export type Mode = "peek" | "half" | "full";

export const isDesktop = () => matchMedia("(min-width: 900px)").matches;

const TOP_GAP = 10;
const PEEK = 168;
const DRAG_THRESHOLD = 8;
const STEP = 40;

export interface Sheet {
  el: HTMLElement;
  setHead(html: string): void;
  /** Replaces the body; `top` scrolls it to the start, for a new pane. */
  setBody(html: string, top: boolean): void;
  setMode(m: Mode): void;
  mode(): Mode;
  /** The height the current mode gives it, without the safe area. */
  height(): number;
  /** Hidden while a place moves. */
  hide(hidden: boolean): void;
}

export interface SheetEvents {
  /** The user asked for another mode with a tap or a drag on the head. */
  mode(m: Mode): void;
  /** A click on an element with `data-act`. */
  action(name: string, data: DOMStringMap, el: HTMLElement): void;
}

/** Up to just under the search pill. */
function fullHeight() {
  return innerHeight - $("search").getBoundingClientRect().bottom - TOP_GAP;
}

export function createSheet(el: HTMLElement, on: SheetEvents): Sheet {
  el.innerHTML = `<div class="grip"></div><header class="sh-head" id="sh-head"></header><div class="body" id="sh-body"></div>`;
  const head = el.querySelector("#sh-head") as HTMLElement;
  const body = el.querySelector("#sh-body") as HTMLElement;
  const root = document.documentElement;
  let mode: Mode = "peek";

  const px = (m: Mode) => {
    if (isDesktop()) return 0;
    return m === "peek" ? PEEK : m === "half" ? Math.round(innerHeight * 0.52) : fullHeight();
  };
  const apply = (h: number) => root.style.setProperty("--sheet", `${h}px`);

  function setMode(m: Mode) {
    mode = m;
    el.className = m;
    document.body.classList.toggle("sheet-full", m === "full" && !isDesktop());
    apply(px(m));
  }

  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-act]");
    if (a) on.action(a.dataset.act as string, a.dataset, a);
  });

  // In peek the whole sheet drags; else its head, so the body scrolls. A drag follows the finger and
  // snaps on release. The pointer is captured only once it moved, so a tap stays a click on its row.
  let drag: { y: number; h: number; moved: boolean; id: number } | null = null;
  let dragged = 0;
  const interactive = "button, a, input, textarea";
  el.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (isDesktop() || e.button !== 0) return;
    const onHead = t.closest(".grip, .sh-head") != null && t.closest(interactive) == null;
    if (!onHead && !(mode === "peek" && !t.closest("a, input"))) return;
    drag = { y: e.clientY, h: px(mode), moved: false, id: e.pointerId };
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      el.setPointerCapture(e.pointerId);
      document.body.classList.add("dragging");
    }
    if (drag.moved) apply(Math.max(PEEK * 0.6, Math.min(px("full"), drag.h - dy)));
  });
  const release = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { y, h, moved } = drag;
    drag = null;
    if (!moved) return;
    dragged = Date.now();
    document.body.classList.remove("dragging");
    const dy = e.clientY - y;
    const order: Mode[] = ["peek", "half", "full"];
    const now = h - dy;
    let next = order.reduce((a, b) => (Math.abs(px(b) - now) < Math.abs(px(a) - now) ? b : a));
    if (next === mode && Math.abs(dy) > STEP) {
      const i = order.indexOf(mode) + (dy < 0 ? 1 : -1);
      next = order[Math.max(0, Math.min(2, i))] as Mode;
    }
    apply(px(next));
    if (next !== mode) on.mode(next);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", () => {
    if (!drag?.moved) return void (drag = null);
    drag = null;
    document.body.classList.remove("dragging");
    apply(px(mode));
  });
  // The click that ends a drag lands on nothing.
  el.addEventListener(
    "click",
    (e) => {
      if (Date.now() - dragged < 300) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
  head.parentElement?.querySelector(".grip")?.addEventListener("click", () => toggle());
  head.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(interactive)) toggle();
  });
  function toggle() {
    if (!isDesktop()) on.mode(mode === "half" ? "full" : "half");
  }

  addEventListener("resize", () => setMode(mode));
  setMode("peek");

  return {
    el,
    setHead(html) {
      head.innerHTML = html;
    },
    setBody(html, top) {
      body.innerHTML = html;
      if (top) body.scrollTop = 0;
    },
    setMode,
    mode: () => mode,
    height: () => px(mode),
    hide(hidden) {
      el.hidden = hidden;
    },
  };
}

// ---------------------------------------------------------------- panes

export type At = { lat: number; lon: number } | null;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function listHead(v: MapView, near: { available: boolean; on: boolean }): string {
  const add = v.editable ? `<button type="button" class="chip add-chip" data-act="new">+ Neu</button>` : "";
  const places = v.entries.reduce((s, e) => s + e.places.length, 0);
  const none = v.entries.filter((e) => !e.places.length).length;
  const facts = [count(v.entries.length, "Eintrag", "Einträge"), count(places, "Ort", "Orte")];
  if (none) facts.push(`${none} ohne Ort`);
  return `<div class="titles"><h2>${esc(v.map.title)}</h2><small>${facts.join(" · ")}</small></div>${
    near.available
      ? `<button type="button" class="chip${near.on ? " on" : ""}" data-act="near" aria-pressed="${near.on}">Nähe</button>`
      : ""
  }${add}`;
}

const firstKm = (e: Entry, me: At) => {
  const p = e.places[0];
  return p && me ? kmBetween(me, p) : null;
};

export function sortEntries(entries: Entry[], me: At, near: boolean): Entry[] {
  if (!near || !me) return entries;
  const key = (e: Entry) => firstKm(e, me) ?? Number.POSITIVE_INFINITY;
  return [...entries].sort((a, b) => key(a) - key(b));
}

function cities(e: Entry): string {
  return e.places.map((p) => cityOf(p)).join(" · ");
}

/** The town of an address like `Musterweg 7, 30163 Hannover`, else the place's label. */
function cityOf(p: Place): string {
  const m = /(?:^|,\s*)\d{4,5}\s+([^,]+)/.exec(p.address);
  if (m) return m[1] as string;
  return p.address.split(",").at(-1)?.trim() || p.label || "Ort";
}

export function entryRow(e: Entry, me: At, editable: boolean): string {
  const km = firstKm(e, me);
  const add =
    !e.places.length && editable
      ? `<button type="button" class="link" data-act="add-place" data-id="${e.id}">Ort hinzufügen</button>`
      : "";
  return `<div class="row" data-entry="${e.id}"><button type="button" class="tap" data-act="open" data-id="${e.id}">${avatar(e)}<span class="txt"><b>${esc(e.name)}</b><small>${e.places.length ? esc(cities(e)) : "Noch kein Ort"}</small></span>${km == null ? "" : `<span class="dist">${distance(km)}</span>`}</button>${add}</div>`;
}

export function trashSection(trash: Entry[], open: boolean, purge: boolean): string {
  if (!trash.length) return "";
  const rows = trash
    .map(
      (e) =>
        `<div class="row gone">${avatar(e)}<span class="txt"><b>${esc(e.name)}</b></span><button type="button" class="link" data-act="undelete" data-id="${e.id}">Wiederherstellen</button>${purge ? `<button type="button" class="link danger" data-act="purge" data-id="${e.id}" aria-label="${esc(e.name)} endgültig löschen">${icon.trash}</button>` : ""}</div>`,
    )
    .join("");
  return `<button type="button" class="trash-head" data-act="trash" aria-expanded="${open}">Gelöscht (${trash.length})</button>${open ? rows : ""}`;
}

export function entriesHtml(rows: Entry[], me: At, editable: boolean): string {
  return rows.map((e) => entryRow(e, me, editable)).join("");
}

export const emptyHtml = (editable: boolean) =>
  `<p class="empty">Noch niemand eingetragen.${editable ? " Tippe auf + und leg den ersten Eintrag an." : ""}</p>`;

const link = (href: string, label: string) =>
  `<a class="out" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;

function placeRow(p: Place, me: At): string {
  const km = me ? kmBetween(me, p) : null;
  return `<div class="place">
    <button type="button" class="where" data-act="fly" data-lat="${p.lat}" data-lon="${p.lon}">
      ${p.label ? `<small>${esc(p.label)}</small>` : ""}<span>${esc(p.address || "Gesetzter Punkt")}</span>${km == null ? "" : `<small>${distance(km)} von dir</small>`}
    </button>
    <div class="links">${link(googleMapsUrl(p.lat, p.lon), "Google Maps")}${link(googleRouteUrl(p.lat, p.lon), "Route")}${link(streetViewUrl(p.lat, p.lon), "Street View")}</div>
  </div>`;
}

const close = () => `<button type="button" class="ib" data-act="close" aria-label="Schließen">${icon.close}</button>`;

export const cardHead = (e: Entry, editable: boolean) =>
  `${editable ? `<button type="button" class="face" data-act="avatar" data-id="${e.id}" aria-label="Bild ändern">${avatar(e)}</button>` : avatar(e)}<h2 class="name">${esc(e.name)}</h2>${close()}`;

export function cardBody(e: Entry, me: At, editable: boolean): string {
  const when = new Date(e.updated).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
  const places = e.places.length
    ? e.places.map((p) => placeRow(p, me)).join("")
    : `<p class="none">Noch kein Ort${editable ? ` · <button type="button" class="link" data-act="add-place" data-id="${e.id}">Ort hinzufügen</button>` : ""}</p>`;
  const edit = editable
    ? `<button type="button" class="primary" data-act="edit" data-id="${e.id}">${icon.edit}<span>Bearbeiten</span></button>`
    : "";
  const del = editable
    ? `<button type="button" class="danger" data-act="delete" data-id="${e.id}">${icon.trash}<span>Löschen</span></button>`
    : "";
  return `${e.note.trim() ? `<p class="note">${esc(e.note)}</p>` : ""}${places}
    <div class="actions">${edit}<button type="button" data-act="link" data-id="${e.id}">${icon.link}<span>Link</span></button>${del}</div>
    ${e.by ? `<p class="foot">Zuletzt geändert von ${esc(e.by)}, ${esc(when)}</p>` : ""}`;
}

export const addressHead = (title: string) => `<h2 class="name plain">${esc(title)}</h2>${close()}`;

export function addressBody(hit: Pick<GeoHit, "label" | "lat" | "lon">, editable: boolean, pending: boolean): string {
  const add = editable
    ? `<div class="actions"><button type="button" class="primary" data-act="new-here">${icon.plus}<span>Neuer Eintrag hier</span></button><button type="button" data-act="pick">Zu Eintrag hinzufügen…</button></div>`
    : "";
  return `<p class="address">${pending ? "Adresse wird gesucht…" : esc(hit.label || "Gewählter Punkt")}</p>
    <div class="links">${link(googleMapsUrl(hit.lat, hit.lon), "In Google Maps öffnen")}${link(streetViewUrl(hit.lat, hit.lon), "Street View")}</div>${add}`;
}

export const groupHead = (n: number) => `<h2 class="name plain">${count(n, "Eintrag", "Einträge")} hier</h2>${close()}`;

export const pickHead = () => `<h2 class="name plain">Zu welchem Eintrag?</h2>${close()}`;

export function pickBody(entries: Entry[]): string {
  return entries
    .map(
      (e) =>
        `<div class="row"><button type="button" class="tap" data-act="pick-entry" data-id="${e.id}">${avatar(e)}<span class="txt"><b>${esc(e.name)}</b><small>${e.places.length ? esc(cities(e)) : "Noch kein Ort"}</small></span></button></div>`,
    )
    .join("");
}

export function hitRow(h: GeoHit, i: number): string {
  return `<div class="hit"><button type="button" class="tap" data-act="hit" data-i="${i}">${icon.pin}<span class="txt"><b>${esc(h.label)}</b></span></button>${link(h.google_url, "Google Maps")}</div>`;
}
