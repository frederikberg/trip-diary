// The editor's pages on the editing host: the start page with the trips and maps, the form for a
// new trip and a trip's settings with its read links. Plain HTML and form posts; one small script
// fills in conveniences and is not needed for any of it to work.
import { createHash } from "node:crypto";

export interface HomeTrip {
  title: string;
  /** Days and notes, e.g. `5 Tage · 23 Notizen`. */
  detail: string;
  /** Path of the trip's page; null when the trip has no live view link. */
  href: string | null;
  /** Path of the trip's settings. */
  settings: string;
}

export interface HomeMap {
  title: string;
  /** Entries, e.g. `10 Einträge`. */
  detail: string;
  /** Path of the map's edit page; null when the map has no live edit link. */
  href: string | null;
}

/**
 * What the forms show: the title fills the slug in while that is untouched, an empty time zone
 * becomes the browser's, a read link's field selects itself. A trip's settings also gather this
 * device's drafts and waiting placements, which the trip page keeps per link
 * (`trip-draft:<token>:<key>`, `trip-outbox:<token>`), from the trip's other links onto the one the
 * editor opens it with (`data-drafts-to`, `data-drafts-from`), as adding or revoking a link moves
 * that one. A draft already there is not overwritten.
 */
const SCRIPT = `(() => {
const zone = document.querySelector("input[data-zone]");
if (zone && !zone.value) zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
const title = document.querySelector("input[data-slug-from]");
const slug = document.querySelector("input[name=slug]");
if (title && slug) {
  let touched = slug.value !== "";
  slug.addEventListener("input", () => { touched = slug.value !== ""; });
  title.addEventListener("input", () => {
    if (touched) return;
    slug.value = title.value.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")
      .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  });
}
for (const f of document.querySelectorAll("input[readonly]")) f.addEventListener("focus", () => f.select());
const gather = document.querySelector("[data-drafts-to]");
if (gather) try {
  const to = gather.dataset.draftsTo;
  for (const from of gather.dataset.draftsFrom.split(" ").filter(Boolean)) {
    const p = "trip-draft:" + from + ":";
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(p)) continue;
      const next = "trip-draft:" + to + ":" + k.slice(p.length);
      if (localStorage.getItem(next) != null) continue;
      localStorage.setItem(next, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
    const queued = JSON.parse(localStorage.getItem("trip-outbox:" + from) || "[]");
    if (!queued.length) continue;
    const there = JSON.parse(localStorage.getItem("trip-outbox:" + to) || "[]");
    const ids = new Set(there.map((q) => q.id));
    localStorage.setItem("trip-outbox:" + to, JSON.stringify(there.concat(queued.filter((q) => !ids.has(q.id)))));
    localStorage.removeItem("trip-outbox:" + from);
  }
} catch {}
})();`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");

/** Content-Security-Policy of the start page: no script, no form. */
export const HOME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Content-Security-Policy of the form pages: forms post to this origin, the one script runs by its hash. */
export const FORM_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
body{margin:0;font:17px/1.4 system-ui,-apple-system,sans-serif;background:#fbf8f1;color:#2b2a26}
main{max-width:34rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.4rem;margin:0 0 1rem}
h2{font-size:1.15rem;margin:1.5rem 0 .7rem}
ul{list-style:none;margin:0;padding:0}
li{margin:0 0 .6rem}
a,.item{display:block;padding:.8rem 1rem;border-radius:.7rem;background:#fff;border:1px solid #e5e0d5;color:inherit;text-decoration:none}
.item{color:#8a8574}
strong{display:block}
small{color:#6c6859}
p.out{margin-top:1.5rem}
p.out a,a.btn{display:inline-block;padding:.5rem 1rem;border-radius:.6rem;border:1px solid #c9c1b0;background:transparent}
.trip{display:flex;gap:.5rem;align-items:stretch}
.trip>a:first-child,.trip>.item{flex:1}
.trip>a.set{display:flex;align-items:center;padding:0 .9rem;color:#6c6859}
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin:0 0 1rem}
.top h1{margin:0}
.top a{padding:.5rem .9rem}
form{margin:0}
fieldset{border:1px solid #e5e0d5;border-radius:.7rem;background:#fff;margin:0 0 1rem;padding:.4rem 1rem 1rem}
legend{font-weight:600;padding:0 .3rem}
label{display:block;margin:.8rem 0 .25rem;font-weight:500}
label.check{display:flex;gap:.6rem;align-items:center;font-weight:400}
label.check input{width:1.3rem;height:1.3rem;margin:0}
input{box-sizing:border-box;width:100%;font:inherit;font-size:16px;padding:.6rem .7rem;border:1px solid #c9c1b0;border-radius:.5rem;background:#fff;color:inherit}
input[type=number]{width:7rem}
input[readonly]{background:#f4f1ea;font-size:14px}
.hint{color:#6c6859;font-size:.9rem;margin:.3rem 0 0}
button{font:inherit;padding:.65rem 1.2rem;border-radius:.6rem;border:1px solid #c9c1b0;background:#fff;color:inherit}
button.primary{background:#2b2a26;border-color:#2b2a26;color:#fbf8f1}
button.danger{border-color:#b42318;color:#b42318}
.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-top:1rem}
.msg{padding:.7rem 1rem;border-radius:.6rem;margin:0 0 1rem}
.msg.ok{background:#e7f2e3}
.msg.err{background:#fbe4e1;color:#8a1c12}
.link{border-top:1px solid #eee8dc;padding:.8rem 0}
.link:first-of-type{border-top:0}
.link .tag{display:inline-block;font-size:.8rem;background:#e7f2e3;border-radius:.4rem;padding:0 .4rem;margin-left:.4rem;font-weight:400}
details{margin-top:.5rem}
summary{cursor:pointer;color:#b42318;padding:.3rem 0}
details.old summary{color:#6c6859}`;

function page(title: string, body: string, script = false): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script>${SCRIPT}</script>\n` : ""}</body>
</html>
`;
}

const item = (t: HomeMap) => {
  const body = `<strong>${esc(t.title)}</strong><small>${esc(t.detail)}</small>`;
  return t.href ? `<a href="${esc(t.href)}">${body}</a>` : `<div class="item">${body}</div>`;
};

export function homePage(trips: HomeTrip[], maps: HomeMap[], signOutPath: string): string {
  const items = trips
    .map(
      (t) =>
        `<li class="trip">${item(t)}<a class="set" href="${esc(t.settings)}" aria-label="Einstellungen: ${esc(t.title)}">Einstellungen</a></li>`,
    )
    .join("\n");
  const karten = maps.length
    ? `<h2>Karten</h2>\n<ul>\n${maps.map((m) => `<li>${item(m)}</li>`).join("\n")}\n</ul>`
    : "";
  return page(
    "Reisetagebuch",
    `<div class="top"><h1>Reisen</h1><a class="btn" href="/trips/new">Neue Reise</a></div>
<ul>
${items || "<li>Noch keine Reise angelegt.</li>"}
</ul>
${karten}
<p class="out"><a href="${esc(signOutPath)}">Abmelden</a></p>`,
  );
}

// ---------------------------------------------------------------- the forms

const msg = (ok: string | null, err: string | null) =>
  (ok ? `<p class="msg ok" role="status">${esc(ok)}</p>` : "") +
  (err ? `<p class="msg err" role="alert">${esc(err)}</p>` : "");

const field = (
  name: string,
  label: string,
  value: string,
  attrs = "",
  hint = "",
  type = "text",
) => `<label for="f-${name}">${esc(label)}</label>
<input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}`;

const zoneField = (value: string, zones: string[]) =>
  `${field("timezone", "Zeitzone", value, 'required list="zones" autocomplete="off" autocapitalize="off" spellcheck="false" data-zone', "In ihr stehen alle Zeiten der Reise, z. B. Europe/Berlin.")}
<datalist id="zones">${zones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist>`;

/** What the form for a new trip holds. */
export interface NewTripForm {
  slug: string;
  title: string;
  short_title: string;
  timezone: string;
  start_date: string;
  end_date: string;
}

export function newTripPage(v: NewTripForm, zones: string[], error: string | null = null): string {
  return page(
    "Neue Reise",
    `<h1>Neue Reise</h1>
${msg(null, error)}
<form method="post" action="/trips/new">
<fieldset><legend>Reise</legend>
${field("title", "Titel", v.title, 'required maxlength="200" autocapitalize="sentences" data-slug-from')}
${field("slug", "Kurzname", v.slug, 'required maxlength="40" pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off" autocapitalize="off" spellcheck="false"', "Kleinbuchstaben, Ziffern und Bindestriche; bleibt für immer.")}
${field("short_title", "Kurztitel", v.short_title, 'maxlength="200"', "Steht, wo der Titel nicht passt. Darf leer bleiben.")}
${zoneField(v.timezone, zones)}
${field("start_date", "Erster Tag", v.start_date, "required", "", "date")}
${field("end_date", "Letzter Tag", v.end_date, "", "Leer lassen, solange das Ende offen ist.", "date")}
</fieldset>
<div class="row"><button class="primary" type="submit">Anlegen</button><a class="btn" href="/">Abbrechen</a></div>
</form>`,
    true,
  );
}

/** What the settings form holds. */
export interface SettingsForm {
  title: string;
  short_title: string;
  timezone: string;
  start_date: string;
  /** The last day; empty for an open end; null for a trip that has no end recorded (no field). */
  end_date: string | null;
  /** The number day 1 shows. */
  first_day: string;
  hide_camps: boolean;
  delay_hours: string;
}

export interface SettingsLink {
  id: number;
  label: string;
  /** Formatted for display. */
  created: string;
  url: string;
  /** The link the trip page's share buttons hand out. */
  handedOut: boolean;
}

export interface SettingsPage {
  slug: string;
  heading: string;
  /** Days and notes, e.g. `5 Tage · 23 Notizen`. */
  detail: string;
  /** Path of the trip's page; null when the trip has no live view link. */
  open: string | null;
  form: SettingsForm;
  /** Whether "end today" is offered: the trip's end is open. */
  canEnd: boolean;
  links: SettingsLink[];
  revoked: { label: string; revoked: string }[];
  /** The view token the editor opens the trip with, and the trip's other tokens, revoked ones too: where this device's drafts gather. */
  drafts: { to: string; from: string[] } | null;
  notice: string | null;
  error: string | null;
}

export function settingsPage(s: SettingsPage, zones: string[]): string {
  const base = `/trips/${encodeURIComponent(s.slug)}`;
  const f = s.form;
  const end =
    f.end_date == null
      ? ""
      : field("end_date", "Letzter Tag", f.end_date, "", "Leer lassen, solange das Ende offen ist.", "date");
  const links = s.links
    .map(
      (
        l,
      ) => `<div class="link"><strong>${esc(l.label)}${l.handedOut ? '<span class="tag">wird geteilt</span>' : ""}</strong>
<small>seit ${esc(l.created)}</small>
<input readonly aria-label="Link ${esc(l.label)}" value="${esc(l.url)}">
<details><summary>Widerrufen …</summary>
<form method="post" action="${base}/shares/${l.id}/revoke">
<p class="hint">Wer nur diesen Link hat, sieht die Reise danach nicht mehr.</p>
<button class="danger" type="submit">Link „${esc(l.label)}“ widerrufen</button>
</form></details></div>`,
    )
    .join("\n");
  const revoked = s.revoked.length
    ? `<details class="old"><summary>Widerrufene Links (${s.revoked.length})</summary><ul>${s.revoked
        .map((r) => `<li>${esc(r.label)} <small>widerrufen am ${esc(r.revoked)}</small></li>`)
        .join("")}</ul></details>`
    : "";
  return page(
    `Einstellungen – ${s.heading}`,
    `${s.drafts ? `<div hidden data-drafts-to="${esc(s.drafts.to)}" data-drafts-from="${esc(s.drafts.from.join(" "))}"></div>\n` : ""}<div class="top"><h1>${esc(s.heading)}</h1>${s.open ? `<a class="btn" href="${esc(s.open)}">Zur Reise</a>` : ""}</div>
<p class="hint">${esc(s.detail)} · <a class="btn" href="/">Alle Reisen</a></p>
${msg(s.notice, s.error)}
<form method="post" action="${base}">
<fieldset><legend>Reise</legend>
${field("title", "Titel", f.title, 'required maxlength="200" autocapitalize="sentences"')}
${field("short_title", "Kurztitel", f.short_title, 'maxlength="200"', "Steht, wo der Titel nicht passt. Darf leer bleiben.")}
${zoneField(f.timezone, zones)}
${field("start_date", "Erster Tag", f.start_date, "", "", "date")}
${end}
${field("first_day", "Der erste Tag heißt Tag", f.first_day, 'required min="-98" max="100" step="1"', "0 oder -1, damit Vorbereitungs- und Anreisetage vor dem eigentlichen Start Tag 0 und Tag -1 heißen. Sonst 1.", "number")}
</fieldset>
<fieldset><legend>Für Leser der Links</legend>
<label class="check"><input type="checkbox" name="hide_camps" value="1"${f.hide_camps ? " checked" : ""}> Lagerplätze verbergen (Art und Name)</label>
${field("delay_hours", "Notizen erst nach … Stunden zeigen", f.delay_hours, 'required inputmode="numeric" min="0" max="8760" step="1"', "0: sofort. Sonst sehen Leser eine neue Notiz erst so viele Stunden nach dem Anlegen.", "number")}
</fieldset>
<div class="row"><button class="primary" type="submit">Speichern</button></div>
</form>
${
  s.canEnd
    ? `<form method="post" action="${base}/end"><div class="row"><button type="submit">Reise heute beenden</button></div><p class="hint">Setzt den letzten Tag auf heute.</p></form>`
    : ""
}
<h2>Links für Freunde</h2>
<fieldset><legend>Geteilte Links</legend>
${links || '<p class="hint">Noch kein Link.</p>'}
${revoked}
</fieldset>
<form method="post" action="${base}/shares">
<fieldset><legend>Neuer Link</legend>
${field("label", "Für wen", "", 'required maxlength="100" placeholder="z. B. Familie"', "Der neue Link wird ab dann geteilt. Einen weitergereichten Link ersetzt du so: neuen anlegen, alten widerrufen.")}
<div class="row"><button type="submit">Link anlegen</button></div>
</fieldset>
</form>`,
    true,
  );
}
