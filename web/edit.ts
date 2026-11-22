// Edit mode: placing and moving notes (or leaving them without a place), a note's time, the text
// editor with a local draft, the photo picker, captions.
import type { LatLng } from "leaflet";
import type { Media, Note } from "../src/shared/api";
import { isoInZone, zonedInstant } from "../src/shared/time";
import { type Api, ApiFailure } from "./api";
import { createPicker } from "./picker";
import { $, esc, icon, label, toast } from "./util";

export interface EditHost {
  api: Api;
  /** The server refused a write for lack of a session. */
  expired(): void;
  refresh(): Promise<void>;
  select(key: string): void;
  close(): void;
  setPlacing(on: boolean): void;
  /** The current position, asking the browser when none is known yet. */
  locate(): Promise<LatLng | null>;
  nextNumber(): number;
  /** Shows the placements still waiting for the network. */
  pending(list: Queued[]): void;
  /** The trip's time zone: a note's time is picked in it. */
  zone: string;
  /** Opens a layer the history's back closes; `dropLayer` when it closes on its own. */
  pushLayer(close: () => void): void;
  dropLayer(): void;
}

/** A placement made without network, kept on the device until the server has it. Null: a note without a place. */
export interface Queued {
  id: string;
  lat: number | null;
  lon: number | null;
  created: string;
}

export interface Edit {
  action(name: string, note: Note): void;
  /** Asks for a new caption and saves it; resolves true when it changed (`m.caption` is updated). */
  caption(note: Note, m: Media): Promise<boolean>;
  remove(note: Note, m: Media): void;
  /** Handles a map tap while placing or moving; false when not placing. */
  mapTap(at: LatLng): boolean;
  togglePlacing(): void;
  placing(): boolean;
}

export function createEdit(host: EditHost): Edit {
  const { api } = host;
  const fail = (e: unknown, what: string) => {
    if (e instanceof ApiFailure && e.status === 403) return host.expired();
    toast(`${what}: ${e instanceof ApiFailure ? e.message : "keine Verbindung"}`, 5000);
  };
  let placing = false;
  let moving: Note | null = null;
  const banner = $("banner");

  function setBanner(html: string | null) {
    banner.innerHTML = html ?? "";
    banner.classList.toggle("show", html != null);
  }

  function stopPlacing() {
    placing = false;
    moving = null;
    host.setPlacing(false);
    setBanner(null);
    $("add")?.classList.remove("active");
  }

  // ---- the outbox: a placement survives a dead network and a closed page
  const outboxKey = `trip-outbox:${api.token}`;
  const outbox = (): Queued[] => JSON.parse(localStorage.getItem(outboxKey) ?? "[]") as Queued[];
  const saveOutbox = (list: Queued[]) => {
    if (list.length) localStorage.setItem(outboxKey, JSON.stringify(list));
    else localStorage.removeItem(outboxKey);
    host.pending(list);
  };
  let flushing = false;

  /** Sends what waits, oldest first; stops at the first network failure and keeps the rest. */
  async function flush(): Promise<void> {
    if (flushing || !outbox().length) return;
    flushing = true;
    let sent: Note | null = null;
    try {
      for (const q of outbox()) {
        try {
          sent = await api.createNote({ lat: q.lat, lon: q.lon, created: q.created, client_id: q.id });
        } catch (e) {
          if (!(e instanceof ApiFailure)) break;
          // Without a session the placement stays queued; any other refusal drops it.
          if (e.status === 403) {
            host.expired();
            break;
          }
          fail(e, "Eine wartende Notiz wurde abgelehnt");
        }
        saveOutbox(outbox().filter((x) => x.id !== q.id));
      }
    } finally {
      flushing = false;
    }
    if (sent) {
      await host.refresh();
      toast(`${label(sent)} ist jetzt gespeichert`);
    }
  }
  addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void flush());
  setInterval(() => void flush(), 30_000);
  host.pending(outbox());
  void flush();

  /** A new note at `at`, or without a place (null): then it stands at the time it was made. */
  async function place(at: { lat: number; lng: number } | null) {
    stopPlacing();
    const created = new Date().toISOString();
    const id = crypto.randomUUID();
    const pos = at ? { lat: at.lat, lon: at.lng } : { lat: null, lon: null };
    try {
      const n = await api.createNote({ ...pos, created, client_id: id });
      await host.refresh();
      host.select(n.key);
      toast(at ? `${label(n)} gesetzt` : `${label(n)} ohne Ort – Zeit: jetzt (zum Ändern antippen)`, at ? 2400 : 4000);
    } catch (e) {
      if (e instanceof ApiFailure) return fail(e, "Nicht gesetzt");
      saveOutbox([...outbox(), { id, ...pos, created }]);
      toast("Ohne Netz – die Notiz wartet auf dem Gerät und geht raus, sobald es wieder Netz gibt.", 5000);
    }
  }

  const bannerButtons = (none: boolean) =>
    `<button data-b="here">${icon.pin}Mein Standort</button>${none ? `<button data-b="none">${icon.noPin}Ohne Ort</button>` : ""}<button data-b="cancel" aria-label="Abbrechen">${icon.close}</button>`;

  banner.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.b === "cancel") return stopPlacing();
    if (b.dataset.b === "none") {
      const n = moving;
      stopPlacing();
      return n ? move(n, null) : place(null);
    }
    if (b.dataset.b === "here") {
      const at = await host.locate();
      if (!at) return toast("Kein Standort verfügbar.", 4000);
      if (moving) {
        const n = moving;
        stopPlacing();
        return move(n, at);
      }
      return place(at);
    }
  });

  /** Moves a note to `at`, or takes its place away (null); the server keeps its time then. */
  async function move(n: Note, at: { lat: number; lng: number } | null) {
    try {
      await api.patchNote(n.key, at ? { lat: at.lat, lon: at.lng } : { lat: null, lon: null });
      await host.refresh();
      host.select(n.key);
      toast(
        at ? `${label(n)} ${n.lat == null ? "hat jetzt einen Ort" : "verschoben"}` : `${label(n)} ist jetzt ohne Ort`,
      );
    } catch (e) {
      fail(e, at ? "Nicht verschoben" : "Ort nicht entfernt");
    }
  }

  // ---- a numbered note's time: a native date-time field in the trip's zone, saved with a button
  function toggleTime(n: Note) {
    const sheet = $("sheet");
    const open = sheet.querySelector("form.when-form");
    if (open) return open.remove();
    const form = document.createElement("form");
    form.className = "when-form";
    form.noValidate = true;
    // The anchor is given in the trip's zone, so its first 16 characters are the wall-clock value.
    const hint =
      n.lat == null
        ? "Ohne Ort steht die Notiz nach dieser Zeit in der Liste."
        : n.at
          ? "Eigene Zeit statt der vom Track."
          : "Die Zeit kommt vom Track; eine eigene ersetzt sie.";
    form.innerHTML = `<input name="at" type="datetime-local" step="60" value="${esc(n.anchor.t.slice(0, 16))}" aria-label="Zeit der Notiz" required><button type="submit">Übernehmen</button>${
      n.lat != null && n.at ? '<button type="button" class="ghost" data-w="track">Zeit vom Track</button>' : ""
    }<p class="hint">${hint}</p><p class="err" role="alert"></p>`;
    sheet.querySelector(".meta")?.after(form);
    const field = form.elements.namedItem("at") as HTMLInputElement;
    const err = form.querySelector(".err") as HTMLElement;
    const save = async (at: string | null) => {
      err.textContent = "";
      try {
        await api.patchNote(n.key, { at });
      } catch (x) {
        if (x instanceof ApiFailure && x.status === 403) return host.expired();
        err.textContent = x instanceof ApiFailure ? `Nicht gesetzt: ${x.message}` : "Keine Verbindung.";
        return;
      }
      await host.refresh();
      host.select(n.key);
      toast(at ? "Zeit gesetzt" : "Die Zeit kommt wieder vom Track");
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(field.value);
      if (!m) {
        err.textContent = "Bitte Datum und Uhrzeit wählen.";
        return;
      }
      void save(isoInZone(zonedInstant(m[1] as string, Number(m[2]), Number(m[3]), host.zone), host.zone));
    });
    form.querySelector('[data-w="track"]')?.addEventListener("click", () => void save(null));
  }

  // ---- the editor: a page of its own in normal document flow. Nothing positions it from script or
  // follows the visual viewport, so the browser alone keeps the caret in view above the keyboard.
  const ed = $("editor");
  const title = $<HTMLInputElement>("e-title");
  const text = $<HTMLTextAreaElement>("e-text");
  let editing: { note: Note; draftKey: string } | null = null;

  /** Grows the text field to its content, so the page is the only thing that scrolls. Never shrinks
   * while open: a shorter page would clamp the scroll position and move the caret off screen. */
  const grow = () => {
    if (text.scrollHeight > text.clientHeight) text.style.height = `${text.scrollHeight}px`;
  };

  function openEditor(n: Note) {
    const draftKey = `trip-draft:${api.token}:${n.key}`;
    editing = { note: n, draftKey };
    const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null") as { title: string; text: string } | null;
    title.value = draft?.title ?? n.title;
    text.value = draft?.text ?? n.text;
    $("e-head").textContent = label(n);
    title.placeholder = n.kind === "day" ? "Titel (sonst der Lagerplatz)" : "Titel";
    document.body.classList.add("editing");
    ed.classList.add("open");
    scrollTo(0, 0);
    text.style.height = "";
    grow();
    if (draft) toast("Entwurf von diesem Gerät wiederhergestellt");
    (n.title || draft?.title ? text : title).focus();
  }

  function closeEditor() {
    ed.classList.remove("open");
    document.body.classList.remove("editing");
    scrollTo(0, 0);
    editing = null;
  }

  const keepDraft = () => {
    if (editing) localStorage.setItem(editing.draftKey, JSON.stringify({ title: title.value, text: text.value }));
  };
  title.addEventListener("input", keepDraft);
  text.addEventListener("input", () => {
    grow();
    keepDraft();
  });

  $("e-cancel").addEventListener("click", () => {
    if (!editing) return;
    const changed = title.value !== editing.note.title || text.value !== editing.note.text;
    if (changed && !confirm("Änderungen verwerfen?")) return;
    localStorage.removeItem(editing.draftKey);
    closeEditor();
  });
  $("e-save").addEventListener("click", async () => {
    if (!editing) return;
    const { note, draftKey } = editing;
    const body = { title: title.value.trim(), text: text.value };
    try {
      try {
        await api.patchNote(note.key, body, note.rev);
      } catch (e) {
        if (!(e instanceof ApiFailure && e.status === 412 && e.body.note)) throw e;
        if (!confirm("Diese Notiz wurde inzwischen woanders geändert. Mit deiner Fassung überschreiben?")) return;
        await api.patchNote(note.key, body, e.body.note.rev);
      }
      localStorage.removeItem(draftKey);
      closeEditor();
      await host.refresh();
      host.select(note.key);
      toast("Gespeichert");
    } catch (e) {
      fail(e, "Nicht gespeichert (der Entwurf bleibt auf diesem Gerät)");
    }
  });

  // ---- photos from Immich: the picker page
  const picker = createPicker({
    api,
    expired: () => host.expired(),
    attached: async (n) => {
      await host.refresh();
      host.select(n.key);
    },
    opened: (close) => host.pushLayer(close),
    closed: () => host.dropLayer(),
  });

  return {
    action(name, n) {
      if (name === "text") openEditor(n);
      else if (name === "photo") picker.open(n);
      else if (name === "time") toggleTime(n);
      else if (name === "move") {
        host.close();
        moving = n;
        placing = true;
        host.setPlacing(true);
        const placed = n.lat != null;
        setBanner(
          `<span>Tippe auf ${placed ? "den neuen Ort" : "den Ort"} für ${esc(label(n))}</span>${bannerButtons(placed)}`,
        );
      } else if (name === "delete") {
        if (!confirm(`${label(n)} mit Text und Fotos löschen?`)) return;
        host.close();
        api
          .deleteNote(n.key)
          .then(() => host.refresh())
          .then(() => toast(`${label(n)} gelöscht`))
          .catch((e) => fail(e, "Nicht gelöscht"));
      }
    },
    async caption(n, m) {
      const v = prompt("Bildunterschrift", m.caption ?? "");
      if (v == null || v === (m.caption ?? "")) return false;
      try {
        const saved = await api.patchMedia(n.key, m.id, { caption: v.trim() || null });
        m.caption = saved.caption;
        void host.refresh();
        return true;
      } catch (e) {
        fail(e, "Nicht gespeichert");
        return false;
      }
    },
    remove(n, m) {
      if (!confirm(`${m.type === "video" ? "Video" : "Foto"} aus ${label(n)} entfernen?`)) return;
      api
        .deleteMedia(n.key, m.id)
        .then(() => host.refresh())
        .then(() => host.select(n.key))
        .catch((e) => fail(e, "Nicht entfernt"));
    },
    mapTap(at) {
      if (!placing) return false;
      if (moving) {
        const n = moving;
        stopPlacing();
        void move(n, at);
      } else void place(at);
      return true;
    },
    togglePlacing() {
      if (placing) return stopPlacing();
      host.close();
      placing = true;
      host.setPlacing(true);
      $("add")?.classList.add("active");
      setBanner(`<span>Tippe auf die Karte für Notiz ${host.nextNumber()}</span>${bannerButtons(true)}`);
    },
    placing: () => placing,
  };
}
