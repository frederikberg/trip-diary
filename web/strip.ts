// The top strip: the trip card, then every note and day end in timeline order.
import type { Day, Note, TripView } from "../src/shared/api";
import { dayColour, dayMonth, dayNo, dayOnly, esc, hhmm, icon, km, noteTitle, weekday } from "./util";

export interface Strip {
  render(view: TripView): void;
  select(key: string | null): void;
  /** Bottom edge in viewport pixels. */
  bottom(): number;
  onTap(fn: (key: string) => void): void;
  onTrip(fn: () => void): void;
}

function chip(n: Note, day: Day | undefined): string {
  const colour = dayColour(n.anchor.day);
  if (n.kind === "day") {
    const s = day?.stats;
    const line = s ? `${km(s.km)} km · ↑${Math.round(s.ascent_m)} m` : "Ruhetag";
    return `<button class="chip day" data-key="${n.key}" style="--day:${dayColour(n.day)}">
      <span class="top"><span class="num">${icon.flag}${dayNo(n.day)}</span>${esc(weekday(n.anchor.t))} ${n.anchor.rule === "rest-day" ? "" : hhmm(n.anchor.t)}</span>
      <span class="t">${esc(noteTitle(n, day))}</span><span class="sub">${line}</span></button>`;
  }
  const count = n.media.length ? `<span class="cam">${icon.camera}${n.media.length}</span>` : "";
  const noPlace = n.lat == null ? `<span class="nopin" title="ohne Ort">${icon.noPin}</span>` : "";
  const untitled = !n.title.trim() && !n.text.trim();
  return `<button class="chip" data-key="${n.key}" style="--day:${colour}">
    <span class="top"><span class="num">${n.number}</span>${esc(weekday(n.anchor.t))} ${hhmm(n.anchor.t)}${noPlace}${count}</span>
    <span class="t${untitled ? " none" : ""}">${esc(noteTitle(n))}</span></button>`;
}

export function createStrip(el: HTMLElement): Strip {
  let tapFn: (key: string) => void = () => {};
  let tripFn: () => void = () => {};
  let selected: string | null = null;

  el.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!c) return;
    if (c.dataset.key === "trip") tripFn();
    else tapFn(c.dataset.key as string);
  });

  function scrollTo(key: string) {
    const c = el.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!c) return;
    const r = c.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (r.left < box.left + 4 || r.right > box.right - 4)
      el.scrollTo({ left: el.scrollLeft + r.left - box.left - (box.width - r.width) / 2, behavior: "smooth" });
  }

  return {
    render(view) {
      const days = new Map(view.days.map((d) => [d.n, d]));
      const starts = view.days.flatMap((d) => (d.track[0] ? [d.track[0][3]] : []));
      const ends = view.days.flatMap((d) => (d.track.at(-1) ? [(d.track.at(-1) as Day["track"][number])[3]] : []));
      const first = starts[0] ?? (view.trip.start_date ? `${view.trip.start_date}T12:00:00Z` : null);
      const last = ends.at(-1) ?? first;
      const dates =
        first && last
          ? dayMonth(first) === dayMonth(last)
            ? dayMonth(first)
            : `${dayOnly(first)}.–${dayMonth(last)}`
          : "";
      const total = view.days.reduce((sum, d) => sum + (d.stats?.km ?? 0), 0);
      const sub = [
        view.days.length ? `${view.days.length} ${view.days.length === 1 ? "Tag" : "Tage"}` : "",
        total ? `${km(total, 0)} km` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const top = [dates, sub].filter(Boolean).join(" · ");
      el.innerHTML =
        `<button class="chip trip" data-key="trip"><span class="top">${esc(top)}</span><span class="t">${esc(view.trip.title)}</span></button>` +
        view.notes.map((n) => chip(n, n.day == null ? undefined : days.get(n.day))).join("");
      if (selected) el.querySelector(`[data-key="${selected}"]`)?.classList.add("sel");
    },
    select(key) {
      const old = el.querySelector(".chip.sel");
      old?.classList.remove("sel");
      old?.removeAttribute("aria-current");
      selected = key;
      if (!key) return;
      const c = el.querySelector(`[data-key="${key}"]`);
      c?.classList.add("sel");
      c?.setAttribute("aria-current", "true");
      scrollTo(key);
    },
    bottom: () => el.getBoundingClientRect().bottom,
    onTap(fn) {
      tapFn = fn;
    },
    onTrip(fn) {
      tripFn = fn;
    },
  };
}
