// The search pill: filters the entries as you type and, from three characters on, asks the geocoder.
import type { Entry, GeoHit } from "../../src/shared/api";
import { ApiFailure, type MapApi } from "./api";
import { fold, icon } from "./util";

const DEBOUNCE_MS = 350;
const MIN_GEOCODE = 3;

export type Addresses =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "hits"; hits: GeoHit[] }
  | { state: "down" };

export interface SearchEvents {
  open(): void;
  /** The text or the address results changed. */
  change(q: string, addresses: Addresses): void;
  /** The clear button: leaves the search. */
  close(): void;
  locate(): void;
  /** Where the search should prefer results. */
  near(): { lat: number; lon: number } | null;
}

export interface Search {
  input: HTMLInputElement;
  /** Empties the field and ends the keyboard. */
  reset(): void;
  setOpen(open: boolean): void;
}

/** Entries whose name or places hold every word of the query. */
export function matchEntries(entries: Entry[], q: string): Entry[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => {
    const hay = fold([e.name, ...e.places.flatMap((p) => [p.label, p.address])].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

export function createSearch(el: HTMLElement, api: MapApi, on: SearchEvents): Search {
  el.innerHTML = `<label for="q" aria-label="Suchen">${icon.search}</label>
    <input id="q" type="search" placeholder="Person oder Adresse suchen" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="search">
    <button type="button" class="round" id="q-side" aria-label="Wo bin ich">${icon.locate}</button>`;
  const input = el.querySelector("#q") as HTMLInputElement;
  const side = el.querySelector("#q-side") as HTMLButtonElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | null = null;
  let open = false;

  function ask(q: string) {
    running?.abort();
    const ctl = new AbortController();
    running = ctl;
    api
      .search(q, on.near(), ctl.signal)
      .then((hits) => {
        if (!ctl.signal.aborted) on.change(input.value, { state: "hits", hits });
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        if (e instanceof ApiFailure && e.status === 400) on.change(input.value, { state: "idle" });
        else on.change(input.value, { state: "down" });
      });
  }

  function changed() {
    clearTimeout(timer);
    running?.abort();
    const q = input.value.trim();
    if (q.length < MIN_GEOCODE) return on.change(input.value, { state: "idle" });
    on.change(input.value, { state: "loading" });
    timer = setTimeout(() => ask(q), DEBOUNCE_MS);
  }

  input.addEventListener("focus", () => {
    if (!open) on.open();
  });
  input.addEventListener("input", changed);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      input.blur();
      const q = input.value.trim();
      if (q.length >= MIN_GEOCODE) ask(q);
    }
  });
  side.addEventListener("click", () => (open ? on.close() : on.locate()));

  return {
    input,
    reset() {
      clearTimeout(timer);
      running?.abort();
      input.value = "";
      input.blur();
    },
    setOpen(o) {
      open = o;
      side.innerHTML = o ? icon.close : icon.locate;
      side.setAttribute("aria-label", o ? "Suche schließen" : "Wo bin ich");
    },
  };
}
