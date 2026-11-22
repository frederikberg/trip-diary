// Small helpers shared by the client modules: DOM, escaping, German formatting in the trip's zone, icons.
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Day, Note } from "../src/shared/api";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown as text formatting only: nothing that could restyle the page, take over an element id or pose as a form. */
export const markdown = (s: string) =>
  DOMPurify.sanitize(marked.parse(s, { async: false, breaks: true }) as string, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "label", "fieldset", "iframe"],
    FORBID_ATTR: ["style", "id", "name", "class", "form"],
  });

/** Track colours by day, cycling. */
const COLOURS = ["#e11d48", "#2563eb", "#c026d3", "#ea580c", "#7c3aed", "#0d9488", "#4d7c0f"];
export const dayColour = (day: number | null) =>
  day == null ? "#6b7280" : (COLOURS[(day - 1) % COLOURS.length] as string);

let zone = "Europe/Berlin";
export const setZone = (tz: string) => {
  zone = tz;
};

/** The trip's `day_offset`: day numbers are stored from 1, shown shifted by it. */
let dayOffset = 0;
export const setDayOffset = (offset: number) => {
  dayOffset = offset;
};
/** The number a day is shown with. */
export const dayNo = (n: number | null) => (n == null ? "" : String(n + dayOffset));

const fmt = (iso: string | number, o: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString("de-DE", { timeZone: zone, ...o });
export const hhmm = (iso: string | number) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
export const weekday = (iso: string | number) => fmt(iso, { weekday: "short" }).replace(".", "");
export const longDate = (iso: string | number) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
export const dayMonth = (iso: string | number) => fmt(iso, { day: "numeric", month: "short" });
export const dayOnly = (iso: string | number) => fmt(iso, { day: "numeric" });

export const km = (v: number, digits = 1) => v.toFixed(digits).replace(".", ",");
export const duration = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")} h`;
export const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A note's title, or what stands in for a missing one. */
export function noteTitle(n: Note, day?: Day): string {
  if (n.title.trim()) return n.title.trim();
  if (n.kind === "day") return day?.end?.name || `Tag ${dayNo(n.day)}`;
  const first = n.text
    .split("\n")
    .map((l) => l.replace(/[#>*_`[\]-]/g, "").trim())
    .find(Boolean);
  if (first) return first.length > 70 ? `${first.slice(0, 68)}…` : first;
  return `Notiz ${n.number}`;
}

export const label = (n: Note) => (n.kind === "day" ? `Tag ${dayNo(n.day)}` : `Notiz ${n.number}`);

// Icons: 24×24 strokes, coloured by currentColor.
const svg = (d: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
export const icon = {
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  locate: svg(
    '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
  ),
  share: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  play: svg('<path d="M8 5l11 7-11 7z" fill="currentColor"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="currentColor"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  move: svg(
    '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  ),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  save: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  pin: svg(
    '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2.5a7 7 0 017 7C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  ),
  caption: svg('<path d="M4 6h16M4 12h10M4 18h7"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  noPin: svg(
    '<path d="M8.3 4.3A7 7 0 0119 9.5c0 2-1 4.2-2.3 6M14.6 18.4C13.3 19.9 12 21 12 21s-7-6.2-7-11.5c0-1 .2-2 .6-2.9M3 3l18 18"/>',
  ),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  friends: svg(
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="17" cy="9.5" r="2.5"/><path d="M15.5 14.3c2.4-.2 4.4 1.2 5 4.2"/>',
  ),
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, ms = 2400): void {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
