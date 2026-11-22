// The editor's start page: plain HTML lists of the trips and maps, each linking to its page.

export interface HomeTrip {
  title: string;
  /** Days and notes, e.g. `5 Tage · 23 Notizen`. */
  detail: string;
  /** Path of the trip's page; null when the trip has no live view link. */
  href: string | null;
}

export interface HomeMap {
  title: string;
  /** Entries, e.g. `10 Einträge`. */
  detail: string;
  /** Path of the map's edit page; null when the map has no live edit link. */
  href: string | null;
}

/** Content-Security-Policy of the page: no script, no form. */
export const HOME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

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
p.out a{display:inline-block;padding:.5rem 1rem;border-radius:.6rem;border:1px solid #c9c1b0;background:transparent}`;

const item = (t: HomeTrip | HomeMap) => {
  const body = `<strong>${esc(t.title)}</strong><small>${esc(t.detail)}</small>`;
  return t.href ? `<li><a href="${esc(t.href)}">${body}</a></li>` : `<li><div class="item">${body}</div></li>`;
};

export function homePage(trips: HomeTrip[], maps: HomeMap[], signOutPath: string): string {
  const items = trips.map(item).join("\n");
  const karten = maps.length ? `<h2>Karten</h2>\n<ul>\n${maps.map(item).join("\n")}\n</ul>` : "";
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Reisetagebuch</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Reisen</h1>
<ul>
${items || "<li>Noch keine Reise angelegt.</li>"}
</ul>
${karten}
<p class="out"><a href="${esc(signOutPath)}">Abmelden</a></p>
</main>
</body>
</html>
`;
}
