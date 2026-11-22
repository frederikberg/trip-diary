// The photo picker: a page of Immich thumbnails from a time window around a note. Taps pick, one
// button attaches the picked ones in the order they were taken; a pasted Immich link still works.
// Like the text editor it is a page in normal document flow, so its link field never sits in a
// fixed box.
import type { Note, Suggestion } from "../src/shared/api";
import { type Api, ApiFailure } from "./api";
import { immichAssetId } from "./immich-link";
import { $, clock, dayNo, esc, hhmm, icon, label, longDate, toast } from "./util";

/** Hours the window spans; "früher" and "später" move it by as much. */
const WINDOW_H = 4;
const HOUR = 3_600_000;

export interface PickerHost {
  api: Api;
  /** The server refused for lack of a login. */
  expired(): void;
  /** Photos were attached to the note: show it again. */
  attached(n: Note): Promise<void>;
  /** The picker opened as a layer of its own; `close` hides it when the history goes back. */
  opened(close: () => void): void;
  /** The picker closed from its own buttons. */
  closed(): void;
}

const ATTACH_ERRORS: Record<number, string> = {
  404: "Dieses Foto gibt es in Immich nicht (oder es liegt im Papierkorb).",
  409: "Dieses Foto hängt schon an dieser Notiz.",
};

const noteName = (key: string) => (key.startsWith("d") ? `Tag ${dayNo(Number(key.slice(1)))}` : key);

export function createPicker(host: PickerHost): { open(n: Note): void } {
  const { api } = host;
  const page = $("picker");
  const grid = $("p-grid");
  const add = $<HTMLButtonElement>("p-add");
  const paste = $<HTMLFormElement>("p-paste");
  const field = $<HTMLInputElement>("p-link");
  const err = paste.querySelector(".err") as HTMLElement;
  $("p-close").innerHTML = icon.close;
  $("p-earlier").innerHTML = `${icon.prev}<span>früher</span>`;
  $("p-later").innerHTML = `<span>später</span>${icon.next}`;

  let note: Note | null = null;
  let from = 0;
  let items: Suggestion[] = [];
  const picked = new Map<string, Suggestion>();
  /** Answers to an older window are dropped. */
  let loads = 0;

  function count() {
    add.disabled = picked.size === 0;
    add.textContent = picked.size ? `${picked.size} anhängen` : "Anhängen";
  }

  function cell(n: Note, s: Suggestion): string {
    const id = s.immich_id;
    const here = s.attached_to.includes(n.key);
    const others = s.attached_to.filter((k) => k !== n.key);
    const kind = s.type === "video" ? "Video" : "Foto";
    const sel = picked.has(id);
    const badge = here
      ? `<span class="p-on">${icon.check}dabei</span>`
      : others.length
        ? `<span class="p-other">an ${esc(others.map(noteName).join(", "))}</span>`
        : "";
    const video =
      s.type === "video" ? `<span class="p-vid">${icon.play}${s.duration_ms ? clock(s.duration_ms) : ""}</span>` : "";
    return `<button type="button" class="p-item${sel ? " sel" : ""}" data-id="${esc(id)}" aria-pressed="${sel}"${here ? " disabled" : ""}
      aria-label="${kind} ${hhmm(s.taken_at)}${here ? ", hängt schon an dieser Notiz" : ""}"><img src="${esc(api.thumb(id))}" alt="" loading="lazy" decoding="async">
      <span class="p-time">${hhmm(s.taken_at)}</span>${video}${badge}<span class="p-tick">${icon.check}</span></button>`;
  }

  function render(n: Note) {
    const to = from + WINDOW_H * HOUR;
    if (!items.length) {
      // Photos from the phone reach Immich only once its app uploaded them.
      const recent = to > Date.now() - 2 * 24 * HOUR;
      grid.innerHTML = `<p class="p-empty">Keine Fotos in diesen ${WINDOW_H} Stunden.${
        recent ? " Fotos vom Handy erscheinen hier erst, wenn die Immich-App sie hochgeladen hat." : ""
      }</p>`;
      return;
    }
    // The note's own time stands between the photos, so the ones taken there are easy to find.
    const t = Date.parse(n.anchor.t);
    const mark = `<p class="p-mark" id="p-mark">${icon.clock}${esc(label(n))} · ${hhmm(t)}</p>`;
    const inside = t >= from && t < to;
    let marked = !inside;
    const cells: string[] = [];
    for (const s of items) {
      if (!marked && Date.parse(s.taken_at) >= t) {
        cells.push(mark);
        marked = true;
      }
      cells.push(cell(n, s));
    }
    if (!marked) cells.push(mark);
    grid.innerHTML = cells.join("");
  }

  async function load(first = false) {
    const n = note;
    if (!n) return;
    const seq = ++loads;
    const to = from + WINDOW_H * HOUR;
    $("p-window").textContent =
      longDate(from) === longDate(to - 1)
        ? `${longDate(from)}, ${hhmm(from)}–${hhmm(to)}`
        : `${longDate(from)} ${hhmm(from)} – ${longDate(to)} ${hhmm(to)}`;
    items = [];
    grid.innerHTML = `<p class="p-empty">Fotos werden geladen …</p>`;
    try {
      const list = await api.suggest(new Date(from), new Date(from + WINDOW_H * HOUR));
      if (seq !== loads || note !== n) return;
      items = list;
    } catch (e) {
      if (seq !== loads) return;
      if (e instanceof ApiFailure && e.status === 403) host.expired();
      grid.innerHTML = `<p class="p-empty err">${
        e instanceof ApiFailure
          ? e.status === 502
            ? "Immich antwortet gerade nicht."
            : esc(e.message)
          : "Keine Verbindung. Ein Immich-Link unten geht auch nicht ohne Netz."
      }</p>`;
      return;
    }
    render(n);
    if (first) document.getElementById("p-mark")?.scrollIntoView({ block: "center" });
  }

  function hide() {
    note = null;
    loads++;
    page.classList.remove("open");
    document.body.classList.remove("picking");
    grid.innerHTML = "";
    field.value = "";
    err.textContent = "";
    scrollTo(0, 0);
  }

  function close() {
    hide();
    host.closed();
  }

  async function done(n: Note, msg: string) {
    close();
    await host.attached(n);
    toast(msg);
  }

  grid.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".p-item");
    if (!b || b.disabled) return;
    const s = items.find((x) => x.immich_id === b.dataset.id);
    if (!s) return;
    if (picked.has(s.immich_id)) picked.delete(s.immich_id);
    else picked.set(s.immich_id, s);
    b.classList.toggle("sel", picked.has(s.immich_id));
    b.setAttribute("aria-pressed", String(picked.has(s.immich_id)));
    count();
  });

  const shift = (k: number) => {
    from += k * WINDOW_H * HOUR;
    void load();
    scrollTo(0, 0);
  };
  $("p-earlier").addEventListener("click", () => shift(-1));
  $("p-later").addEventListener("click", () => shift(1));
  $("p-close").addEventListener("click", close);
  $("p-cancel").addEventListener("click", close);

  add.addEventListener("click", async () => {
    const n = note;
    if (!n || !picked.size) return;
    const list = [...picked.values()].sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
    add.disabled = true;
    add.textContent = "Wird angehängt …";
    let attached = 0;
    for (const s of list) {
      try {
        await api.attach(n.key, s.immich_id);
        attached++;
      } catch (e) {
        // Already on the note: nothing to do for this one.
        if (!(e instanceof ApiFailure && e.status === 409)) {
          if (e instanceof ApiFailure && e.status === 403) host.expired();
          toast(
            `${attached} von ${list.length} angehängt – ${e instanceof ApiFailure ? (ATTACH_ERRORS[e.status] ?? e.message) : "keine Verbindung"}`,
            6000,
          );
          await load();
          count();
          return;
        }
      }
      picked.delete(s.immich_id);
    }
    await done(n, attached === 1 ? "1 Foto angehängt" : `${attached} Fotos angehängt`);
  });

  paste.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = note;
    if (!n) return;
    const id = immichAssetId(field.value);
    if (!id) {
      err.textContent = "Das ist kein Immich-Foto-Link. Öffne das Foto in Immich und kopiere die Adresse.";
      return;
    }
    err.textContent = "";
    try {
      await api.attach(n.key, id);
    } catch (x) {
      if (x instanceof ApiFailure && x.status === 403) return host.expired();
      err.textContent =
        x instanceof ApiFailure ? (ATTACH_ERRORS[x.status] ?? `Nicht hinzugefügt: ${x.message}`) : "Keine Verbindung.";
      return;
    }
    await done(n, "Foto hinzugefügt");
  });

  return {
    open(n) {
      note = n;
      // Whole hours around the note's time, the note a little after the middle.
      from = Math.floor((Date.parse(n.anchor.t) - (WINDOW_H / 2) * HOUR) / HOUR) * HOUR;
      picked.clear();
      count();
      $("p-head").textContent = `Fotos für ${label(n)}`;
      $("toast").classList.remove("show");
      document.body.classList.add("picking");
      page.classList.add("open");
      scrollTo(0, 0);
      host.opened(hide);
      void load(true);
    },
  };
}
