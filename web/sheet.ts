// The note sheet: a bottom sheet on phones (half, full, peek), a side panel on desktop.
import type { Day, Media, Note } from "../src/shared/api";
import { createPlayer, switchesHtml } from "./player";
import { clock, dayColour, duration, esc, hhmm, icon, km, longDate, markdown, noteTitle } from "./util";

export type Mode = "closed" | "half" | "full" | "peek";

export interface SheetEvents {
  prev(): void;
  next(): void;
  close(): void;
  /** The user asks for another mode: a tap or a drag on the header. */
  mode(m: Mode): void;
  /** The full-screen viewer was asked for on the medium at this index. */
  media(index: number): void;
  action(name: string): void;
}

export interface Sheet {
  el: HTMLElement;
  render(n: Note, day: Day | undefined, ctx: { first: boolean; last: boolean; editable: boolean }): void;
  setMode(m: Mode): void;
  mode(): Mode;
  /** Play or pause the note's video; false when it has none. */
  togglePlayback(): boolean;
  pausePlayback(): void;
}

export const isDesktop = () => matchMedia("(min-width: 900px)").matches;

function profile(d: Day): string {
  const pts = d.track.filter((p) => p[2] != null);
  if (pts.length < 2) return "";
  const W = 360;
  const H = 100;
  let dist = 0;
  const xs: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Day["track"][number];
    const b = pts[i] as Day["track"][number];
    const k = Math.cos((a[0] * Math.PI) / 180);
    dist += Math.hypot((b[1] - a[1]) * 111.32 * k, (b[0] - a[0]) * 110.54);
    xs.push(dist);
  }
  const eles = pts.map((p) => p[2] as number);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  const x = (i: number) => ((xs[i] as number) / (dist || 1)) * W;
  const y = (e: number) => H - 16 - ((e - lo) / (hi - lo || 1)) * (H - 30);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p[2] as number).toFixed(1)}`).join(" ");
  const c = dayColour(d.n);
  const top = d.stats?.max_ele ?? Math.round(hi);
  const bottom = d.stats?.min_ele ?? Math.round(lo);
  const len = d.stats?.km ?? dist;
  return `<figure class="profile"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Höhenprofil">
    <polygon points="0,${H - 16} ${line} ${W},${H - 16}" fill="${c}26"/>
    <polyline points="${line}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <span class="hi">${Math.round(top)} m</span><span class="lo">${Math.round(bottom)} m</span><span class="len">${km(len)} km</span></figure>`;
}

function stats(d: Day): string {
  const s = d.stats;
  if (!s) return "";
  const cell = (v: string, l: string) => `<div><b>${v}</b><small>${l}</small></div>`;
  return `<div class="stats">${[
    cell(`${km(s.km)} km`, "Strecke"),
    cell(`↑${Math.round(s.ascent_m)} ↓${Math.round(s.descent_m)}`, "Höhenmeter"),
    cell(duration(s.moving_time_min), "in Bewegung"),
    cell(hhmm(s.start_time), "Start"),
    cell(hhmm(s.end_time), "Ankunft"),
    cell(`${Math.round(s.max_ele)} m`, "höchster Punkt"),
  ].join("")}</div>`;
}

const CAMP: Record<string, string> = { wild: "Wildcamp", nature: "Naturcamp", trekking: "Trekkingplatz" };

function meta(n: Note, day: Day | undefined, editable: boolean): string {
  const a = n.anchor;
  const parts: string[] = [];
  if (a.day != null) parts.push(esc(`Tag ${a.day}`));
  if (a.rule === "rest-day") parts.push(esc(longDate(a.t)), "Ruhetag");
  else {
    const when = `${longDate(a.t)} · ${a.rule === "day-end" ? `Ankunft ${hhmm(a.t)}` : a.rule === "track" ? `ca. ${hhmm(a.t)}` : hhmm(a.t)}`;
    // The editor changes a numbered note's time from here.
    parts.push(
      editable && n.kind === "note"
        ? `<button class="when" data-act="time" aria-label="Zeit ändern: ${esc(when)}">${icon.clock}${esc(when)}</button>`
        : esc(when),
    );
  }
  if (n.kind === "note" && a.km != null && a.rule === "track") parts.push(esc(`km ${km(a.km)}`));
  if (n.kind === "note" && n.lat == null) parts.push("ohne Ort");
  if (n.kind === "day" && day?.end?.camp_type) parts.push(esc(CAMP[day.end.camp_type]));
  let warn = "";
  if (editable && n.kind === "note" && a.off_track && a.dist_m != null)
    warn = ` <span class="warn">${icon.warn} ${a.dist_m >= 1000 ? `${km(a.dist_m / 1000)} km` : `${a.dist_m} m`} neben dem Track</span>`;
  return `<p class="meta">${parts.join(" · ")}${warn}</p>`;
}

function mediaRow(media: Media[]): string {
  if (!media.length) return "";
  const one = media.length === 1;
  const videos = media.filter((m) => m.type === "video").length;
  const row = `<div class="media${one ? " one" : ""}">${media
    .map((m, i) => {
      const w = m.width ?? 4;
      const h = m.height ?? 3;
      const style = one ? `aspect-ratio:${w}/${h}` : `width:${Math.round((176 * w) / h)}px`;
      const count = i === 0 && media.length > 1 ? `<span class="count">${icon.camera}${media.length}</span>` : "";
      const img = `<img src="${esc(m.preview)}" alt="${esc(m.caption ?? "")}" loading="lazy" decoding="async">`;
      if (m.type !== "video")
        return `<button class="m" data-i="${i}" style="${style}" aria-label="Foto ${i + 1} von ${media.length}">${img}${count}</button>`;
      // A video plays in its tile; only the corner button opens the viewer.
      return `<div class="m vid" data-i="${i}" style="${style}">${img}<video src="${esc(m.video as string)}" muted playsinline preload="none"></video>
        <button class="pp" aria-label="Video ${i + 1} von ${media.length} abspielen oder anhalten"><span class="play">${icon.play}</span></button>
        ${m.duration_ms ? `<span class="dur">${clock(m.duration_ms)}</span>` : ""}${count}
        <button class="fs" aria-label="Video im Vollbild">${icon.fit}</button></div>`;
    })
    .join("")}</div>`;
  return (videos ? switchesHtml() : "") + row;
}

export function createSheet(el: HTMLElement, on: SheetEvents): Sheet {
  el.innerHTML = `<header class="sh-head" id="sh-head"><span class="num" id="s-num"></span><h2 id="s-title"></h2>
      <button class="ib" id="s-prev" aria-label="Vorherige Notiz">${icon.prev}</button>
      <button class="ib" id="s-next" aria-label="Nächste Notiz">${icon.next}</button>
      <button class="ib" id="s-close" aria-label="Schließen">${icon.close}</button></header>
    <div class="body" id="s-body"></div>`;
  const q = <T extends HTMLElement>(id: string) => el.querySelector(`#${id}`) as T;
  const head = q("sh-head");
  const body = q("s-body");
  let mode: Mode = "closed";
  const player = createPlayer(body);
  let shown = "";

  q("s-prev").addEventListener("click", (e) => {
    e.stopPropagation();
    on.prev();
  });
  q("s-next").addEventListener("click", (e) => {
    e.stopPropagation();
    on.next();
  });
  q("s-close").addEventListener("click", (e) => {
    e.stopPropagation();
    on.close();
  });
  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>(".m");
    if (m?.classList.contains("vid")) {
      if (t.closest(".fs")) on.media(Number(m.dataset.i));
      else if (t.closest(".pp")) player.tap(Number(m.dataset.i));
      return;
    }
    if (m) return on.media(Number(m.dataset.i));
    const a = t.closest<HTMLElement>("[data-act]");
    if (a) on.action(a.dataset.act as string);
  });

  // Header: a tap cycles half ⇄ full (peek → half); a drag follows the finger and snaps on release.
  // Taps go through "click": acting on pointerup would resize the sheet before the browser's
  // compatibility click, which then lands on whatever moved under the finger.
  let drag: { y: number; h: number; moved: boolean } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if (isDesktop() || (e.target as HTMLElement).closest("button")) return;
    drag = { y: e.clientY, h: el.getBoundingClientRect().height, moved: false };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 8) drag.moved = true;
    if (drag.moved) el.style.height = `${Math.max(64, Math.min(innerHeight - 90, drag.h - dy))}px`;
  });
  const release = (e: PointerEvent) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    el.style.height = "";
    if (dy < -40) on.mode(mode === "peek" ? "half" : "full");
    else if (dy > 40) on.mode(mode === "full" ? "half" : mode === "half" ? "peek" : "closed");
  };
  head.addEventListener("pointerup", release);
  head.addEventListener("pointercancel", release);
  head.addEventListener("click", (e) => {
    if (isDesktop() || (e.target as HTMLElement).closest("button")) return;
    on.mode(mode === "half" ? "full" : "half");
  });

  return {
    el,
    render(n, day, ctx) {
      const num = q("s-num");
      num.className = `num${n.kind === "day" ? " day" : ""}`;
      num.style.setProperty("--day", dayColour(n.kind === "day" ? n.day : n.anchor.day));
      num.innerHTML = n.kind === "day" ? `${icon.flag}${n.day}` : String(n.number);
      q("s-title").textContent = noteTitle(n, day);
      (q("s-prev") as HTMLButtonElement).disabled = ctx.first;
      (q("s-next") as HTMLButtonElement).disabled = ctx.last;
      let h = meta(n, day, ctx.editable);
      if (n.kind === "day" && day) h += stats(day) + profile(day);
      h += mediaRow(n.media);
      h += n.text.trim()
        ? `<div class="entry">${markdown(n.text)}</div>`
        : `<p class="entry none">${ctx.editable ? "Noch kein Text. Tippe auf „Text“." : "Noch kein Text."}</p>`;
      if (ctx.editable) {
        const btn = (act: string, ic: string, text: string, cls = "") =>
          `<button class="${cls}" data-act="${act}">${ic}<span>${text}</span></button>`;
        const move = n.lat == null ? btn("move", icon.pin, "Ort setzen") : btn("move", icon.move, "Verschieben");
        h += `<div class="actions">${btn("text", icon.edit, "Text", "primary")}${btn("photo", icon.camera, "Foto")}${
          n.kind === "note" ? move + btn("delete", icon.trash, "", "danger") : ""
        }</div>`;
      }
      h += `<p class="foot"><button class="link" data-act="link">${icon.link}<span>Link zu dieser Notiz</span></button></p>`;
      // The same note drawn again (a refreshed view) keeps its video where it stood.
      player.release(n.key === shown);
      shown = n.key;
      body.innerHTML = h;
      body.scrollTop = 0;
      player.attach(n.key);
    },
    setMode(m) {
      mode = m;
      if (m === "closed") {
        player.release(false);
        shown = "";
      } else if (m === "peek") player.pause();
      el.className = m === "closed" ? "" : `open ${m}`;
      document.body.classList.toggle("sheet-open", m !== "closed");
    },
    mode: () => mode,
    togglePlayback: () => player.toggle(),
    pausePlayback: () => player.pause(),
  };
}
