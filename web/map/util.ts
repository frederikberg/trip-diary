// Helpers of the map page: avatars, distances, normalised text, the toast with its undo button.
import type { Entry } from "../../src/shared/api";
import { PALETTE } from "../../src/shared/palette";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export { PALETTE };

const graphemes = (s: string) =>
  [...new Intl.Segmenter("de", { granularity: "grapheme" }).segment(s)].map((g) => g.segment);

/** Up to two capitals from the name's words; `und` and `&` do not count. */
export function initials(name: string): string {
  const words = name.split(/[\s&+,/]+/).filter((w) => /\p{L}/u.test(w) && !/^(und|and)$/i.test(w));
  const letters = (words.length ? words : [name]).slice(0, 2).map((w) => graphemes(w)[0] ?? "");
  return letters.join("").toUpperCase();
}

/** What a pin and an avatar show when there is no picture. */
export const face = (e: Pick<Entry, "name" | "emoji">) => e.emoji ?? initials(e.name);

let pictures = "";
/** Where this page's token finds its pictures. */
export const setPictures = (base: string) => {
  pictures = base;
};

/** The inside of a pin or an avatar. */
export const faceHtml = (e: Pick<Entry, "name" | "emoji" | "avatar">) =>
  e.avatar
    ? `<img src="${esc(`${pictures}/avatar/${e.avatar}`)}" alt="" loading="lazy" decoding="async">`
    : esc(face(e));

/** The last character typed: the emoji field holds one. */
export const lastGrapheme = (s: string) => graphemes(s).at(-1) ?? "";

export const avatar = (e: Pick<Entry, "name" | "emoji" | "color" | "avatar">) =>
  `<span class="av${e.emoji ? " emoji" : ""}" style="background:${PALETTE[e.color % PALETTE.length]}">${faceHtml(e)}</span>`;

export function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

export const distance = (km: number) => (km < 10 ? `${km.toFixed(1).replace(".", ",")} km` : `${Math.round(km)} km`);

/** For matching: lower case, no accents, `ß` as `ss`. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss");

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icon = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  locate: svg(
    '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
  ),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  share: svg(
    '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/>',
  ),
  friends: svg(
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="17" cy="9.5" r="2.5"/><path d="M15.5 14.3c2.4-.2 4.4 1.2 5 4.2"/>',
  ),
  meet: svg(
    '<path d="M12 21s-5-4.6-5-8.5a5 5 0 0110 0c0 3.9-5 8.5-5 8.5z"/><path d="M6.5 8.5A4 4 0 002 11.800c0 1.200.5 2.500 1.200 3.700M17.500 8.500A4 4 0 0122 11.800c0 1.200-.5 2.500-1.200 3.700"/><circle cx="12" cy="12.500" r="1.600"/>',
  ),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.500"/>'),
  pin: svg(
    '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2.5a7 7 0 017 7C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  ),
};

let timer: ReturnType<typeof setTimeout> | undefined;

/** A short message; with `undo`, also a button that runs it. Undoable messages stay 8 s. */
export function toast(msg: string, undo?: () => void): void {
  const t = $("toast");
  t.textContent = msg;
  if (undo) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Rückgängig";
    b.onclick = () => {
      t.classList.remove("show");
      undo();
    };
    t.append(b);
  }
  t.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove("show"), undo ? 8000 : 3500);
}

/** Opens the system share sheet, or copies the link. */
export async function shareLink(url: string, title: string): Promise<void> {
  if (navigator.share) return navigator.share({ title, url }).catch(() => {});
  try {
    await navigator.clipboard.writeText(url);
    toast("Link kopiert");
  } catch {
    toast("Kopieren ging hier nicht.");
  }
}
