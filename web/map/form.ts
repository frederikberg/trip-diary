// The form for an entry: a page in normal document flow, like the trip page's note editor. Nothing in
// it is fixed and nothing follows the on-screen keyboard; while it is open the app behind it is hidden.
import type { Entry, EntryPatch, Place, PlaceInput } from "../../src/shared/api";
import { failureText, type MapApi } from "./api";
import { esc, icon, lastGrapheme, toast } from "./util";

const DEBOUNCE_MS = 350;
const MIN_GEOCODE = 3;
const SEARCHING = `<p class="hint searching" role="status"><span class="spin" aria-hidden="true"></span>Sucht…</p>`;
const MAX_PLACES = 10;
const BY_KEY = "map-by";

interface Row {
  id?: string;
  label: string;
  address: string;
  lat: number | null;
  lon: number | null;
  /** The address text the coordinates belong to. */
  located: string | null;
  /** An address offered for coordinates set on the map, while the user's own text stays. */
  offer?: string;
}

/** The stored fields the form started from: a save sends what differs from them. */
interface Base {
  name: string;
  emoji: string;
  note: string;
  places: Place[];
}

interface Draft {
  id: number | null;
  base: Base;
  clientId: string;
  name: string;
  emoji: string;
  note: string;
  rows: Row[];
}

export interface Seed {
  /** The entry to edit; none for a new one. */
  entry?: Entry;
  /** A place to add to the form. */
  place?: { label?: string; address: string; lat: number | null; lon: number | null };
  /** Starts with the cursor in the first place's address. */
  focusPlace?: boolean;
}

export interface FormHost {
  api: MapApi;
  token: string;
  locate(): Promise<{ lat: number; lon: number } | null>;
  /** The form hides while a place is moved on the map; resolves with where the pin ended, or null. */
  move(at: { lat: number; lon: number } | null): Promise<{ lat: number; lon: number } | null>;
  /** Closed with Abbrechen. */
  cancelled(): void;
  /** Saved; `undo` puts the state before the save back, when there is one. */
  saved(entry: Entry, undo: number | null, revived: boolean): void;
}

export interface Form {
  open(seed: Seed): void;
  /** Hides the form; the draft stays. */
  hide(): void;
  /** Brings a hidden form back as it was. */
  show(): void;
  /** Takes in a newer state of the entry: every field the user has not changed follows it. */
  absorb(entries: Entry[]): void;
  isOpen(): boolean;
}

const emptyRow = (): Row => ({ label: "", address: "", lat: null, lon: null, located: null });

const rowOf = (p: Place): Row => ({ ...p, located: p.address });

const emptyBase = (): Base => ({ name: "", emoji: "", note: "", places: [] });

/** What the rows change against the places they started from. */
function placeEdits(rows: Row[], base: Place[]) {
  const was = new Map(base.map((p) => [p.id, p]));
  const input = (r: Row): PlaceInput => ({
    ...(r.id ? { id: r.id } : {}),
    label: r.label,
    address: r.address,
    lat: r.lat as number,
    lon: r.lon as number,
  });
  const located = rows.filter((r) => r.lat != null);
  const changed = located.filter((r) => {
    const p = r.id ? was.get(r.id) : undefined;
    return p && (p.label !== r.label || p.address !== r.address || p.lat !== r.lat || p.lon !== r.lon);
  });
  const kept = new Set(located.map((r) => r.id));
  return {
    changed: new Map(changed.map((r) => [r.id as string, input(r)])),
    added: located.filter((r) => !r.id || !was.has(r.id)).map(input),
    removed: new Set(base.filter((p) => !kept.has(p.id)).map((p) => p.id)),
  };
}

type Edits = ReturnType<typeof placeEdits>;

const noEdits = (e: Edits) => !e.changed.size && !e.added.length && !e.removed.size;

/** The user's edits on top of the places as they are now, so someone else's places stay. */
function mergePlaces(current: Place[], e: Edits): PlaceInput[] {
  const here = new Set(current.map((p) => p.id));
  return [
    ...current.filter((p) => !e.removed.has(p.id)).map((p) => e.changed.get(p.id) ?? p),
    ...[...e.changed].filter(([id]) => !here.has(id)).map(([, p]) => p),
    ...e.added,
  ];
}

export function createForm(el: HTMLElement, host: FormHost): Form {
  let d: Draft = { id: null, base: emptyBase(), clientId: "", name: "", emoji: "", note: "", rows: [] };
  let open = false;
  let saving = false;
  let scrolled = 0;

  const key = () => `map-draft:${host.token}:${d.id ?? "new"}`;
  const drop = () => localStorage.removeItem(key());
  const edits = () => placeEdits(d.rows, d.base.places);
  const typedPlace = () => d.rows.some((r) => r.lat == null && (r.address.trim() || r.label.trim()));
  const dirty = () =>
    d.name !== d.base.name || d.emoji !== d.base.emoji || d.note !== d.base.note || typedPlace() || !noEdits(edits());
  /** A form nobody changed leaves no draft. */
  const keep = () => (dirty() ? localStorage.setItem(key(), JSON.stringify(d)) : drop());

  const statusOf = (r: Row) => {
    if (r.lat == null)
      return r.address.trim() ? "Noch keine Position: Vorschlag wählen oder auf der Karte setzen." : "";
    if (r.located !== r.address)
      return "Adresse geändert: Vorschlag wählen, auf der Karte setzen oder alte Position behalten.";
    return "Position gesetzt.";
  };

  const moved = (r: Row) => r.lat != null && r.located !== r.address;

  const offerHtml = (r: Row) =>
    (r.offer ? `<button type="button" class="chip" data-act="take">Adresse übernehmen? ${esc(r.offer)}</button>` : "") +
    (moved(r) ? `<button type="button" class="chip" data-act="keep">Alte Position behalten</button>` : "");

  function rowHtml(r: Row, i: number): string {
    return `<fieldset class="place-row" data-i="${i}">
      <div class="line">
        <input class="p-label" list="place-labels" maxlength="40" placeholder="Zuhause" aria-label="Bezeichnung" autocomplete="off" autocapitalize="sentences" value="${esc(r.label)}">
        <button type="button" class="ib" data-act="drop" aria-label="Ort entfernen">${icon.trash}</button>
      </div>
      <input class="p-address" maxlength="200" placeholder="Adresse suchen" aria-label="Adresse" autocomplete="off" autocorrect="off" enterkeyhint="search" value="${esc(r.address)}">
      <div class="sugg"></div>
      <p class="status${r.lat != null && r.located === r.address ? " ok" : ""}">${esc(statusOf(r))}</p>
      <div class="offer">${offerHtml(r)}</div>
      <div class="line tools">
        <button type="button" data-act="map">${icon.pin}<span>Auf Karte setzen</span></button>
        <button type="button" data-act="here">Mein Standort verwenden</button>
      </div>
    </fieldset>`;
  }

  function page() {
    el.innerHTML = `<header><h2>${d.id == null ? "Neuer Eintrag" : "Eintrag bearbeiten"}</h2><button type="button" id="f-cancel">Abbrechen</button></header>
      <div class="field-row">
        <label class="grow">Name<input id="f-name" maxlength="80" autocomplete="off" autocapitalize="words" autocorrect="off" enterkeyhint="next" value="${esc(d.name)}"></label>
        <label class="short">Emoji<input id="f-emoji" autocomplete="off" aria-label="Emoji, statt Initialen" placeholder="🙂" value="${esc(d.emoji)}"></label>
      </div>
      <p class="error" id="f-name-error" hidden>Bitte einen Namen eintragen.</p>
      <label>Notiz<textarea id="f-note" maxlength="2000" rows="3" autocapitalize="sentences"></textarea></label>
      <h3>Orte</h3>
      <div id="f-rows"></div>
      <button type="button" id="f-add" class="ghost">${icon.plus}<span>Ort</span></button>
      <datalist id="place-labels"><option value="Zuhause"><option value="Arbeit"><option value="Eltern"><option value="Wochenende"></datalist>
      <label>Dein Name (optional)<input id="f-by" maxlength="40" autocomplete="name" autocapitalize="words" autocorrect="off" enterkeyhint="done"></label>
      <p class="hint">Steht beim Eintrag, damit die anderen sehen, wer zuletzt etwas geändert hat. Bleibt auf diesem Gerät gespeichert.</p>
      <footer><button type="button" id="f-save" class="save">Sichern</button></footer>`;
    q<HTMLTextAreaElement>("f-note").value = d.note;
    q<HTMLInputElement>("f-by").value = localStorage.getItem(BY_KEY) ?? "";
    rows();
    q("f-cancel").onclick = () => {
      drop();
      host.cancelled();
    };
    q("f-add").onclick = () => {
      if (d.rows.length >= MAX_PLACES) return toast(`Ein Eintrag hat höchstens ${MAX_PLACES} Orte.`);
      d.rows.push(emptyRow());
      rows();
      keep();
    };
    q("f-save").onclick = () => void save();
    q<HTMLInputElement>("f-name").oninput = (e) => {
      d.name = (e.target as HTMLInputElement).value;
      q("f-name-error").hidden = true;
      keep();
    };
    q<HTMLInputElement>("f-emoji").oninput = (e) => {
      const t = e.target as HTMLInputElement;
      const one = lastGrapheme(t.value);
      if (one !== t.value) t.value = one;
      d.emoji = one;
      keep();
    };
    q<HTMLTextAreaElement>("f-note").oninput = (e) => {
      d.note = (e.target as HTMLTextAreaElement).value;
      keep();
    };
  }

  const q = <T extends HTMLElement = HTMLElement>(id: string) => el.querySelector(`#${id}`) as T;

  function rows() {
    q("f-rows").innerHTML = d.rows.map(rowHtml).join("");
  }

  const rowEl = (i: number) => el.querySelector(`.place-row[data-i="${i}"]`) as HTMLElement;
  const at = (t: HTMLElement) => Number((t.closest(".place-row") as HTMLElement).dataset.i);

  function status(i: number) {
    const r = d.rows[i] as Row;
    const p = rowEl(i).querySelector(".status") as HTMLElement;
    p.textContent = statusOf(r);
    p.className = `status${r.lat != null && r.located === r.address ? " ok" : ""}`;
  }

  function offer(i: number) {
    const r = d.rows[i] as Row;
    const box = rowEl(i).querySelector(".offer") as HTMLElement;
    box.innerHTML = offerHtml(r);
  }

  // ---- address suggestions, in the flow under their field
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lookup = 0;

  function suggestions(i: number, html: string) {
    (rowEl(i).querySelector(".sugg") as HTMLElement).innerHTML = html;
  }

  async function suggest(i: number, text: string, now = false) {
    clearTimeout(timer);
    const seq = ++lookup;
    if (text.trim().length < MIN_GEOCODE) return suggestions(i, "");
    suggestions(i, SEARCHING);
    if (!now) await new Promise<void>((done) => (timer = setTimeout(done, DEBOUNCE_MS)));
    if (seq !== lookup) return;
    try {
      const hits = await host.api.search(text.trim(), null);
      if (seq !== lookup || !open) return;
      suggestions(
        i,
        hits.length
          ? hits
              .map(
                (h, n) =>
                  `<button type="button" data-act="sugg" data-n="${n}" data-lat="${h.lat}" data-lon="${h.lon}" data-label="${esc(h.label)}">${icon.pin}<span>${esc(h.label)}</span></button>`,
              )
              .join("")
          : `<p class="hint">Nichts gefunden. Du kannst den Ort auf der Karte setzen.</p>`,
      );
    } catch {
      if (seq === lookup && open)
        suggestions(
          i,
          `<p class="hint">Adresssuche gerade nicht erreichbar. Du kannst den Ort auf der Karte setzen.</p>`,
        );
    }
  }

  async function reverseInto(i: number, at: { lat: number; lon: number }) {
    const r = d.rows[i] as Row;
    const own = r.address.trim() && r.located !== r.address;
    const had = r.address;
    r.lat = at.lat;
    r.lon = at.lon;
    r.located = r.address;
    r.offer = undefined;
    status(i);
    offer(i);
    keep();
    const hits = await host.api.reverse(at.lat, at.lon).catch(() => []);
    const label = hits[0]?.label;
    if (!label || !open || d.rows[i] !== r || r.address !== had) return;
    if (own) {
      r.offer = label;
      offer(i);
    } else {
      r.address = label;
      r.located = label;
      (rowEl(i).querySelector(".p-address") as HTMLInputElement).value = label;
      status(i);
    }
    keep();
  }

  el.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.closest(".place-row")) return;
    const i = at(t);
    const r = d.rows[i] as Row;
    if (t.classList.contains("p-label")) r.label = t.value;
    if (t.classList.contains("p-address")) {
      r.address = t.value;
      rowEl(i).classList.remove("wrong");
      status(i);
      offer(i);
      void suggest(i, t.value);
    }
    keep();
  });

  el.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.classList.contains("p-address")) {
      e.preventDefault();
      void suggest(at(t), (t as HTMLInputElement).value, true);
    }
  });

  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b) return;
    const i = at(b);
    const r = d.rows[i] as Row;
    const act = b.dataset.act;
    if (act === "drop") {
      d.rows.splice(i, 1);
      rows();
      keep();
    } else if (act === "sugg") {
      lookup++;
      clearTimeout(timer);
      r.address = b.dataset.label as string;
      r.located = r.address;
      r.lat = Number(b.dataset.lat);
      r.lon = Number(b.dataset.lon);
      r.offer = undefined;
      rowEl(i).classList.remove("wrong");
      (rowEl(i).querySelector(".p-address") as HTMLInputElement).value = r.address;
      suggestions(i, "");
      status(i);
      offer(i);
      keep();
    } else if (act === "take") {
      r.address = r.offer as string;
      r.located = r.address;
      r.offer = undefined;
      (rowEl(i).querySelector(".p-address") as HTMLInputElement).value = r.address;
      status(i);
      offer(i);
      keep();
    } else if (act === "keep") {
      r.located = r.address;
      rowEl(i).classList.remove("wrong");
      status(i);
      offer(i);
      keep();
    } else if (act === "map") {
      void host.move(r.lat == null ? null : { lat: r.lat, lon: r.lon as number }).then((p) => {
        if (p) void reverseInto(i, p);
      });
    } else if (act === "here") {
      void host.locate().then((p) => {
        if (p) void reverseInto(i, p);
      });
    }
  });

  // ---- saving
  /** False when a row's address has no position, or no longer belongs to the position it has. */
  function allLocated(): boolean {
    const open = d.rows.findIndex((r) => (r.lat == null ? r.address.trim() : moved(r)));
    if (open < 0) return true;
    const row = rowEl(open);
    row.classList.add("wrong");
    row.scrollIntoView({ block: "center" });
    toast(d.rows[open]?.lat == null ? "Ein Ort hat noch keine Position." : "Passt die Position noch zur Adresse?");
    return false;
  }

  /** Sends what the user changed and nothing else; the latest write to a field wins. */
  async function changes(id: number): Promise<EntryPatch> {
    const b = d.base;
    const patch: EntryPatch = {};
    if (d.name.trim() !== b.name) patch.name = d.name.trim();
    if (d.emoji !== b.emoji) patch.emoji = d.emoji || null;
    if (d.note !== b.note) patch.note = d.note;
    const e = edits();
    if (!noEdits(e)) patch.places = mergePlaces((await host.api.get(id)).places, e);
    return patch;
  }

  async function save() {
    if (saving) return;
    const name = d.name.trim();
    if (!name) {
      q("f-name-error").hidden = false;
      q("f-name").focus();
      return;
    }
    if (!allLocated()) return;
    if (d.rows.length > MAX_PLACES) return toast(`Ein Eintrag hat höchstens ${MAX_PLACES} Orte.`);
    const by = q<HTMLInputElement>("f-by").value.trim() || null;
    if (by) localStorage.setItem(BY_KEY, by);
    else localStorage.removeItem(BY_KEY);
    saving = true;
    q<HTMLButtonElement>("f-save").disabled = true;
    try {
      if (d.id == null) {
        const places = placeEdits(d.rows, []).added;
        const body = { name, emoji: d.emoji || null, note: d.note, places, by, client_id: d.clientId };
        const e = await host.api.create(body);
        drop();
        host.saved(e, null, false);
      } else {
        const patch = await changes(d.id);
        if (!Object.keys(patch).length) {
          drop();
          return host.cancelled();
        }
        const e = await host.api.patch(d.id, { ...patch, by });
        drop();
        host.saved(e, e.undo_rev, e.revived === true);
      }
    } catch (e) {
      toast(`Nicht gesichert. ${failureText(e)}`);
    } finally {
      saving = false;
      if (open) q<HTMLButtonElement>("f-save").disabled = false;
    }
  }

  const baseOf = (e: Entry): Base => ({ name: e.name, emoji: e.emoji ?? "", note: e.note, places: e.places });

  const fromEntry = (e: Entry): Draft => ({
    id: e.id,
    base: baseOf(e),
    clientId: "",
    name: e.name,
    emoji: e.emoji ?? "",
    note: e.note,
    rows: e.places.map(rowOf),
  });

  function absorb(e: Entry) {
    const next = baseOf(e);
    const field = (k: "name" | "emoji" | "note", id: string) => {
      if (d[k] === d.base[k]) {
        d[k] = next[k];
        q<HTMLInputElement>(id).value = next[k];
      }
      d.base[k] = next[k];
    };
    field("name", "f-name");
    field("emoji", "f-emoji");
    field("note", "f-note");
    // Rows in use stay as they are; `mergePlaces` keeps the other places at the save.
    const inRows = q("f-rows").contains(document.activeElement);
    if (noEdits(edits()) && !typedPlace() && !inRows) {
      d.base.places = next.places;
      d.rows = next.places.map(rowOf);
      if (!d.rows.length) d.rows.push(emptyRow());
      rows();
    }
    keep();
  }

  function stored(id: number | null): Draft | null {
    const raw = localStorage.getItem(`map-draft:${host.token}:${id ?? "new"}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Draft;
    } catch {
      return null;
    }
  }

  return {
    open(seed) {
      const e = seed.entry;
      const blank: Draft = {
        id: null,
        base: emptyBase(),
        clientId: crypto.randomUUID(),
        name: "",
        emoji: "",
        note: "",
        rows: [],
      };
      const base = e ? fromEntry(e) : blank;
      const old = seed.place ? null : stored(e?.id ?? null);
      const next = old ?? base;
      if (seed.place) next.rows.push({ ...emptyRow(), ...seed.place, located: seed.place.address });
      if (!next.rows.length) next.rows.push(emptyRow());
      if (seed.focusPlace && next.rows.at(-1)?.address) next.rows.push(emptyRow());
      d = next;
      open = true;
      el.hidden = false;
      document.body.classList.add("form-open");
      page();
      scrollTo(0, 0);
      if (old && e) absorb(e);
      if (old) toast("Entwurf wiederhergestellt.");
      const focus = seed.focusPlace
        ? (el.querySelector(".place-row:last-of-type .p-address") as HTMLElement)
        : q("f-name");
      if (!e || seed.focusPlace) focus.focus();
    },
    hide() {
      scrolled = scrollY;
      open = false;
      lookup++;
      clearTimeout(timer);
      el.hidden = true;
      document.body.classList.remove("form-open");
      scrollTo(0, 0);
    },
    show() {
      open = true;
      el.hidden = false;
      document.body.classList.add("form-open");
      scrollTo(0, scrolled);
    },
    absorb(entries) {
      const e = entries.find((x) => x.id === d.id);
      if (e) absorb(e);
    },
    isOpen: () => open,
  };
}
