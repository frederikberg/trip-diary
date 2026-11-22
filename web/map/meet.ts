// The meeting point's pane: the result, the middle, who comes and how.
import type { Entry, MeetBasis, MeetCandidate, MeetLeg, MeetMember, MeetState, Place } from "../../src/shared/api";
import { googleMapsUrl, googleRouteUrl } from "../../src/shared/maplinks";
import { avatar, esc, icon } from "./util";

/** The server's gap between two train requests, for the time left. */
const SECONDS_PER_REQUEST = 1.1;
const MODE = { car: "🚗", train: "🚆" };
const WEIGHT_MAX = 4;

export const duration = (min: number) =>
  min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;

const link = (href: string, label: string) =>
  `<a class="out" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;

const when = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", ...o });

/** What changed since the result: `Alex dazu`, `Sam 🚗→🚆`. */
export function changes(state: MeetState, entries: Entry[]): string[] {
  const based = state.result?.based_on ?? [];
  const name = (id: number) => entries.find((e) => e.id === id)?.name;
  const was = new Map<number, MeetBasis>(based.map((b) => [b.entry_id, b]));
  const out: string[] = [];
  for (const m of state.members) {
    const b = was.get(m.entry_id);
    was.delete(m.entry_id);
    const who = name(m.entry_id) ?? "";
    if (!b) out.push(`${who} dazu`);
    else {
      if (b.mode !== m.mode) out.push(`${who} ${MODE[b.mode]}→${MODE[m.mode]}`);
      if (b.weight !== m.weight) out.push(`${who} ${b.weight}→${m.weight} Personen`);
    }
  }
  for (const b of was.values()) out.push(`${b.name} raus`);
  return out;
}

function progress(state: MeetState): string {
  const job = state.job;
  if (!job || job.error) return "";
  const left = Math.max(0, job.total - job.done);
  const min = Math.ceil((left * SECONDS_PER_REQUEST) / 60);
  const text = !job.total
    ? "Rechnet…"
    : `${job.done} von ${job.total} Verbindungen${left ? ` · noch etwa ${min} Min` : ""}`;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 8;
  return `<div class="meet-bar"><i style="width:${pct}%"></i></div><p class="meet-sub">${text}</p>`;
}

function resultBox(
  state: MeetState,
  entries: Entry[],
  selected: number,
  near: string | null,
  editable: boolean,
): string {
  const r = state.result;
  const c = r?.candidates[selected];
  const running = state.job != null && !state.job.error;
  const parts: string[] = [];
  if (r && c) {
    const longest = c.legs.reduce((a, b) => ((b.minutes ?? 0) > (a.minutes ?? 0) ? b : a));
    const who = entries.find((e) => e.id === longest.entry_id)?.name ?? "";
    parts.push(`<p class="meet-best">${selected + 1}. ${esc(c.station.name)}</p>
      <p class="meet-sub">im Schnitt <b>${duration(c.mean_min)}</b> · am längsten <b>${duration(c.max_min)}</b> (${esc(who)})</p>
      <div class="links">${link(googleMapsUrl(c.station.lat, c.station.lon), "Google Maps")}${link(googleRouteUrl(c.station.lat, c.station.lon), "Route")}</div>`);
    if (r.candidates.length > 1)
      parts.push(
        `<div class="meet-others">${r.candidates
          .map(
            (x: MeetCandidate, i: number) =>
              `<button type="button" class="chip${i === selected ? " on" : ""}" data-act="meet-pick" data-i="${i}">${i + 1}. ${esc(x.station.name)}</button>`,
          )
          .join("")}</div>`,
      );
  } else if (!running) parts.push(`<p class="meet-sub">Noch nichts berechnet.</p>`);
  const m = state.centroid;
  if (m)
    parts.push(
      `<p class="meet-middle-line">Mitte (Luftlinie)${near ? `: bei <b>${esc(near)}</b>` : ""} ${link(googleMapsUrl(m.lat, m.lon), "Google Maps")}</p>`,
    );
  if (r) {
    const at = when(r.computed_at, {
      weekday: "short",
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dep = when(r.departure, { weekday: "short", day: "numeric", month: "numeric", hour: "numeric" });
    parts.push(`<p class="meet-sub">Berechnet ${esc(at)} · Bahn für ${esc(dep)}</p>`);
    if (r.notes.length) parts.push(`<ul class="meet-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
  }
  if (state.stale && !running) {
    const list = changes(state, entries);
    parts.push(`<p class="meet-stale">Seitdem geändert${list.length ? `: ${esc(list.join(", "))}` : ""}</p>`);
  }
  if (state.job?.error) parts.push(`<p class="meet-stale">${esc(state.job.error)}</p>`);
  if (running) parts.push(progress(state));
  else if (editable)
    parts.push(
      `<button type="button" class="meet-go" data-act="meet-compute"${state.members.length < 2 ? " disabled" : ""}>${state.members.length < 2 ? "Mindestens zwei auswählen" : r ? "Neu berechnen" : "Berechnen"}</button>`,
    );
  return `<div class="meet-result">${parts.join("")}</div>`;
}

function legText(l: MeetLeg | undefined): string {
  if (!l) return "";
  if (l.by === "car-fallback") return "keine Bahn gefunden, mit dem Auto";
  if (!l.station) return "";
  return `ab ${l.station}${l.access_min ? `, ${duration(l.access_min)} Anfahrt` : ""}`;
}

function memberRow(e: Entry, m: MeetMember | undefined, leg: MeetLeg | undefined, editable: boolean): string {
  const time = leg ? `<span class="time">${leg.minutes == null ? "–" : duration(leg.minutes)}</span>` : "";
  if (!e.places.length)
    return `<div class="meet-row off"><div class="top"><span class="check"></span>${avatar(e)}<span class="who">${esc(e.name)}</span><small class="dist">noch kein Ort</small></div></div>`;
  const check = editable
    ? `<button type="button" class="check" role="checkbox" aria-checked="${m != null}" aria-label="${esc(e.name)} kommt" data-act="meet-toggle" data-id="${e.id}"><i>${m ? "✓" : ""}</i></button>`
    : `<span class="check"><i></i></span>`;
  if (!m) {
    if (!editable) return "";
    return `<div class="meet-row off"><div class="top">${check}${avatar(e)}<span class="who">${esc(e.name)}</span></div></div>`;
  }
  const place = (p: Place, i: number) =>
    `<option value="${esc(p.id)}"${(m.place_id ?? e.places[0]?.id) === p.id ? " selected" : ""}>${esc(p.label || p.address || `Ort ${i + 1}`)}</option>`;
  const via = legText(leg);
  const ctl = editable
    ? `<div class="ctl"><span class="meet-mode">${(["car", "train"] as const)
        .map(
          (k) =>
            `<button type="button" data-act="meet-mode" data-id="${e.id}" data-mode="${k}" aria-pressed="${m.mode === k}" aria-label="${k === "car" ? "Auto" : "Bahn"}">${MODE[k]}</button>`,
        )
        .join(
          "",
        )}</span><span class="meet-step"><button type="button" data-act="meet-weight" data-id="${e.id}" data-w="${m.weight - 1}" aria-label="Eine Person weniger"${m.weight <= 1 ? " disabled" : ""}>−</button><span>${m.weight}</span><button type="button" data-act="meet-weight" data-id="${e.id}" data-w="${m.weight + 1}" aria-label="Eine Person mehr"${m.weight >= WEIGHT_MAX ? " disabled" : ""}>+</button></span></div>${
        e.places.length > 1
          ? `<select data-id="${e.id}" aria-label="Von welchem Ort">${e.places.map(place).join("")}</select>`
          : ""
      }`
    : `<p class="via">${MODE[m.mode]} · ${m.weight} ${m.weight === 1 ? "Person" : "Personen"}</p>`;
  return `<div class="meet-row"><div class="top">${editable ? check : ""}${avatar(e)}<span class="who">${esc(e.name)}</span>${time}</div>${ctl}${via ? `<p class="via">${esc(via)}</p>` : ""}</div>`;
}

export const meetHead = () =>
  `<h2 class="name plain">Treffpunkt</h2><button type="button" class="ib" data-act="close" aria-label="Schließen">${icon.close}</button>`;

export function meetBody(
  state: MeetState,
  entries: Entry[],
  selected: number,
  near: string | null,
  editable: boolean,
): string {
  const legs = state.result?.candidates[selected]?.legs ?? [];
  const member = new Map(state.members.map((m) => [m.entry_id, m]));
  const rows = [...entries].sort((a, b) => Number(!member.has(a.id)) - Number(!member.has(b.id)));
  const people = state.members.reduce((s, m) => s + m.weight, 0);
  const list = rows
    .map((e) =>
      memberRow(
        e,
        member.get(e.id),
        legs.find((l) => l.entry_id === e.id),
        editable,
      ),
    )
    .join("");
  return `${resultBox(state, entries, selected, near, editable)}
    <p class="meet-who"><b>Wer kommt?</b><span>${state.members.length} von ${entries.filter((e) => e.places.length).length} · ${people} ${people === 1 ? "Person" : "Personen"}</span></p>
    ${list}
    <p class="credit">Fahrzeiten: OSRM / OpenStreetMap, Deutsche Bahn. Bahn von Hauptbahnhof zu Hauptbahnhof.</p>`;
}
