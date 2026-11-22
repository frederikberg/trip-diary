#!/usr/bin/env bun
// Drives the map page by touch on a phone (390×844) and by mouse on a desktop (1440×900) against the
// sample map on a fake geocoder, checks every action, and saves screenshots:
//   bun run build && bun e2e/map.ts [out-dir]
// Needs a Chromium (see e2e/browsers.ts) and the network: the base map comes from the tile host.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright-core";
import type { MapCreated, MapView } from "../src/shared/api";
import { chromiumPath, webglArgs } from "./browsers";
import { LONG_NAME, SAMPLE_ENTRIES } from "./sample-map";
import { type Stack, startStack } from "./stack";

const out = process.argv[2] ?? join(homedir(), ".tmp", "trip-diary-map");
await mkdir(out, { recursive: true });

const results: { ok: boolean; name: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  results.push({ ok, name });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
}

interface State {
  pane: string;
  mode: string;
  searching: boolean;
  layers: number;
  zoom: number;
}
interface Marker {
  key: string;
  x: number;
  y: number;
}
type People = {
  people: {
    state(): State;
    markers(): Marker[];
    map: {
      getCenter(): { lat: number; lng: number };
      loaded(): boolean;
      getZoom(): number;
      jumpTo(o: unknown): void;
      fitBounds(b: unknown, o: unknown): void;
    };
    point(lat: number, lon: number): { x: number; y: number };
  };
};
const state = (p: Page) => p.evaluate(() => (window as unknown as People).people.state());
const markers = (p: Page) => p.evaluate(() => (window as unknown as People).people.markers());
const center = (p: Page) => p.evaluate(() => (window as unknown as People).people.map.getCenter());
const jump = (p: Page, lat: number, lon: number, zoom: number) =>
  p.evaluate(
    ([la, lo, z]) => (window as unknown as People).people.map.jumpTo({ center: [lo, la], zoom: z }),
    [lat, lon, zoom],
  );
const settle = (p: Page, ms = 450) => p.waitForTimeout(ms);
const shot = async (p: Page, name: string) => {
  await p.waitForTimeout(250);
  await p.screenshot({ path: join(out, `${name}.png`), timeout: 120_000 });
};

// ---- real touch through the browser's input pipeline
class Touch {
  private constructor(
    private cdp: CDPSession,
    private page: Page,
  ) {}
  static async on(ctx: BrowserContext, page: Page) {
    return new Touch(await ctx.newCDPSession(page), page);
  }
  private send(type: string, pts: { x: number; y: number }[]) {
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts } as never);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, steps = 12) {
    await this.send("touchStart", [{ x: x1, y: y1 }]);
    for (let i = 1; i <= steps; i++) {
      await this.send("touchMove", [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }]);
      await this.page.waitForTimeout(16);
    }
    // The finger rests before it lifts: after a flick Chromium swallows taps for a moment, whatever the page does.
    await this.page.waitForTimeout(150);
    await this.send("touchEnd", []);
    await settle(this.page);
  }
  async hold(x: number, y: number, ms = 700) {
    await this.send("touchStart", [{ x, y }]);
    await this.page.waitForTimeout(ms);
    await this.send("touchEnd", []);
    await settle(this.page);
  }
  tap(x: number, y: number) {
    return this.page.touchscreen.tap(x, y);
  }
  async tapEl(selector: string) {
    const el = await this.page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    await el.scrollIntoViewIfNeeded();
    const b = await el.boundingBox();
    if (!b) throw new Error(`no box for ${selector}`);
    await this.tap(b.x + b.width / 2, b.y + b.height / 2);
    await settle(this.page, 250);
  }
}

const phoneContext = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  geolocation: { latitude: 50.94, longitude: 6.96 },
  permissions: ["geolocation"],
};

async function watch(p: Page, errors: string[]) {
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
}

async function open(p: Page, url: string) {
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => (window as unknown as People).people?.map.loaded(), undefined, { timeout: 30_000 });
  await settle(p, 900);
}

/** Visible buttons and links smaller than a finger, in the current state. */
const smallTargets = (p: Page, min = 40) =>
  p.evaluate((m) => {
    const out: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>("button, a.out, input")) {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      if (!r.width || s.visibility === "hidden" || r.top >= innerHeight || r.bottom <= 0) continue;
      if ((e as HTMLInputElement).type === "file") continue;
      if (r.height < m || r.width < m)
        out.push(
          `${e.id || e.className || e.tagName}:${e.textContent?.slice(0, 14)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return out;
  }, min);

/** The page's own scroll and any content wider than the screen. */
const pageStill = (p: Page) =>
  p.evaluate(() => ({
    y: scrollY,
    x: scrollX,
    wide: document.documentElement.scrollWidth - innerWidth,
    sheetWide: (() => {
      const b = document.querySelector("#sheet .body") as HTMLElement;
      return b.scrollWidth - b.clientWidth;
    })(),
  }));

// ---------------------------------------------------------------- the phone, write link
async function phone(browser: Browser, stack: Stack) {
  const ctx = await browser.newContext(phoneContext);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  const t = await Touch.on(ctx, p);
  await open(p, `${stack.base}/m/${stack.mapEdit}`);

  const places = SAMPLE_ENTRIES.reduce((s, e) => s + (e.places?.length ?? 0), 0);
  check("the map loaded with its worker", await p.evaluate(() => (window as unknown as People).people.map.loaded()));
  const m0 = await markers(p);
  check(
    "pins and clusters account for every place",
    m0.reduce((s, m) => s + (m.key.startsWith("c:") ? m.key.split(",").length : 1), 0) === places,
    m0,
  );
  check(
    "places close together cluster at Germany zoom",
    m0.some((m) => m.key.startsWith("c:")),
  );
  check("the sheet starts in peek", (await state(p)).mode === "peek");
  await p.evaluate(() => document.documentElement.style.setProperty("--x", "0"));
  await shot(p, "phone-01-start");
  check("no small tap targets at the start", (await smallTargets(p)).length === 0, await smallTargets(p));
  await t.tapEl("#share");
  check("the share button offers the read and the write link", await p.isVisible("#share-menu"));
  await shot(p, "phone-01b-share");
  check("no small tap targets in the share menu", (await smallTargets(p)).length === 0, await smallTargets(p));
  await t.tapEl("#share");
  check("tapping it again closes the menu", !(await p.isVisible("#share-menu")));

  // A long drag on the map pans it; the sheet stays, the page does not scroll.
  const c0 = await center(p);
  await t.swipe(120, 300, 220, 420);
  const c1 = await center(p);
  check("dragging the map pans it", Math.abs(c0.lat - c1.lat) + Math.abs(c0.lng - c1.lng) > 0.05, { c0, c1 });
  check("dragging the map leaves the sheet alone", (await state(p)).mode === "peek");
  check("the page did not scroll", (await pageStill(p)).y === 0);
  // Swipes starting on the pill or a button do not move the page either.
  await t.swipe(195, 34, 195, 300);
  await t.swipe(352, 580, 352, 200);
  check(
    "swipes on the pill and the buttons leave the page",
    (await pageStill(p)).y === 0 && (await p.$eval("#search", (e) => e.getBoundingClientRect().top)) === 10,
  );

  // Dragging the sheet resizes it and leaves the map where it is.
  await t.swipe(195, 690, 195, 420);
  check("dragging the sheet up opens it", (await state(p)).mode === "half", await state(p));
  const c2 = await center(p);
  check("dragging the sheet does not pan the map", Math.abs(c2.lat - c1.lat) + Math.abs(c2.lng - c1.lng) < 1e-6);
  await shot(p, "phone-02-half");
  const headY = await p.$eval("#sh-head", (e) => e.getBoundingClientRect().top + 10);
  await t.swipe(195, headY, 195, 90);
  check("dragging the head up goes to full", (await state(p)).mode === "full", await state(p));
  await shot(p, "phone-03-full");
  const longRow = await p.$eval(".row b", () => {
    const b = [...document.querySelectorAll<HTMLElement>(".row b")].find((x) =>
      x.textContent?.startsWith("Maximiliane"),
    );
    return b ? Math.round(b.getBoundingClientRect().height) : 0;
  });
  check("a long name wraps in the list", longRow > 22, longRow);
  check("nothing is wider than the sheet", (await pageStill(p)).sheetWide <= 0, await pageStill(p));
  // Scrolling the list does not move the sheet or the page.
  const top0 = await p.$eval("#sheet", (e) => e.getBoundingClientRect().top);
  await t.swipe(195, 700, 195, 300);
  check(
    "the list scrolls inside the sheet",
    (await p.$eval("#sh-body", (e) => e.scrollTop)) > 0 &&
      (await p.$eval("#sheet", (e) => e.getBoundingClientRect().top)) === top0,
  );
  const head2 = await p.$eval("#sh-head", (e) => e.getBoundingClientRect().top + 10);
  await t.swipe(195, head2, 195, 780);
  await t.swipe(195, 690, 195, 800);
  check("dragging down returns to peek", (await state(p)).mode === "peek", await state(p));

  // A pin: the card with its links.
  const anna = (SAMPLE_ENTRIES[0] as { places: { lat: number; lon: number }[] }).places[0] as {
    lat: number;
    lon: number;
  };
  await jump(p, 50.9, 6.6, 7);
  await settle(p, 600);
  const pin = (await markers(p)).find((m) => m.key.startsWith("p:1:"));
  check("the pin stands alone at this zoom", !!pin);
  await t.tap((pin as Marker).x, (pin as Marker).y);
  await settle(p);
  const s = await state(p);
  check("a tap on a pin opens its card", s.pane === "card" && s.mode === "half", s);
  const hrefs = await p.$$eval("#sheet a.out", (a) =>
    a.map((x) => [x.textContent, x.getAttribute("href"), x.getAttribute("rel"), x.getAttribute("target")]),
  );
  const links = hrefs.slice(0, 3).map((h) => h[1]);
  check(
    "Google Maps link",
    links[0] === `https://www.google.com/maps/search/?api=1&query=${anna.lat}%2C${anna.lon}`,
    links,
  );
  check(
    "route link",
    links[1] === `https://www.google.com/maps/dir/?api=1&destination=${anna.lat}%2C${anna.lon}`,
    links,
  );
  check(
    "Street View link",
    links[2] === `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${anna.lat}%2C${anna.lon}`,
    links,
  );
  check(
    "every place has the three links, without referrer",
    hrefs.length === 6 && hrefs.every((h) => h[2] === "noopener noreferrer" && h[3] === "_blank"),
    hrefs,
  );
  check("the selected pin has its ring", (await p.$$(".pin.sel")).length === 2);
  check("the URL names the entry", new URL(p.url()).searchParams.get("e") !== null);
  check("no small tap targets on the card", (await smallTargets(p)).length === 0, await smallTargets(p));
  await shot(p, "phone-04-card");
  await p.goBack();
  await settle(p);
  check("back closes the card", (await state(p)).pane === "list" && !new URL(p.url()).search, await state(p));

  // A cluster zooms in.
  await p.evaluate(() =>
    (window as unknown as People).people.map.fitBounds(
      [
        [5.6, 47.6],
        [13.2, 54.8],
      ],
      { padding: { top: 80, bottom: 200, left: 30, right: 70 }, duration: 0 },
    ),
  );
  await settle(p, 700);
  const cl = (await markers(p)).find((m) => m.key.startsWith("c:") && m.key.split(",").length >= 3);
  check("a big cluster is there", !!cl);
  const z0 = (await state(p)).zoom;
  await t.tap((cl as Marker).x, (cl as Marker).y);
  await settle(p, 900);
  check("a tap on a cluster zooms to its members", (await state(p)).zoom > z0 + 1, await state(p));
  await shot(p, "phone-05-cluster-zoomed");

  // Search: people and addresses.
  await t.tapEl("#q");
  check("the search opens the sheet", (await state(p)).searching && (await state(p)).mode === "full", await state(p));
  await p.keyboard.type("Beisp");
  await p.waitForSelector(".hit");
  check("addresses appear with their Google link", (await p.$$(".hit a.out")).length === 2);
  check(
    "the hits show street and town",
    (await p.$eval(".hit b", (e) => e.textContent)) === "Beispielallee 33, 30161 Hannover",
  );
  await shot(p, "phone-06-search-address");
  await p.fill("#q", "");
  await p.keyboard.type("Hann");
  await p.waitForTimeout(100);
  check("people filter by their town", (await p.$$(".body .row")).length === 4, (await p.$$(".body .row")).length);
  await p.fill("#q", "beisp");
  await p.waitForSelector(".hit");
  await t.tapEl('[data-act="hit"]');
  await settle(p, 1000);
  const s2 = await state(p);
  check("an address opens as a card with a temporary pin", s2.pane === "address" && !s2.searching, s2);
  check("the temporary pin stands", (await p.$$(".temp-pin")).length === 1);
  check("the search text is gone", (await p.inputValue("#q")) === "");
  await shot(p, "phone-07-address");

  // A new entry from it.
  await t.tapEl('[data-act="new-here"]');
  check("the form opens with the address", (await p.inputValue(".p-address")) === "Beispielallee 33, 30161 Hannover");
  check("the form says the position is set", (await p.$eval(".status", (e) => e.textContent)) === "Position gesetzt.");
  await p.keyboard.type("Hanna");
  check("the name field got the focus", (await p.inputValue("#f-name")) === "Hanna");
  await shot(p, "phone-08-form");
  check("no small tap targets in the form", (await smallTargets(p)).length === 0, await smallTargets(p));
  await t.tapEl("#f-emoji");
  await p.keyboard.insertText("🐝");
  await p.keyboard.insertText("🦉");
  check("the emoji field keeps one", (await p.inputValue("#f-emoji")) === "🦉");
  await t.tapEl("#f-note");
  await p.keyboard.type("Neu in der Stadt.");
  await t.tapEl("#f-by");
  await p.keyboard.type("Testerin");
  await t.tapEl("#f-save");
  await settle(p, 800);
  check(
    "saving shows the new entry",
    (await state(p)).pane === "card" && (await p.$eval(".sh-head .name", (e) => e.textContent)) === "Hanna",
    await state(p),
  );
  check("the writer's name shows", (await p.$eval(".foot", (e) => e.textContent ?? "")).includes("Testerin"));
  check("the temporary pin is gone", (await p.$$(".temp-pin")).length === 0);
  check(
    "the new pin carries the emoji",
    (await p.$$eval(".pin.sel", (e) => e.map((x) => x.textContent))).some((x) => x?.startsWith("🦉")),
  );
  await shot(p, "phone-09-saved");

  // Editing and undoing it.
  await t.tapEl('[data-act="edit"]');
  await p.fill("#f-note", "Geändert.");
  await t.tapEl("#f-save");
  await settle(p, 700);
  check("the edit shows", (await p.$eval(".note", (e) => e.textContent)) === "Geändert.");
  await shot(p, "phone-10-undo-toast");
  await t.tapEl("#toast button");
  await settle(p, 700);
  check("undo restores the earlier text", (await p.$eval(".note", (e) => e.textContent)) === "Neu in der Stadt.");

  // Moving a place with a finger.
  await t.tapEl('[data-act="edit"]');
  await t.tapEl('[data-act="map"]');
  await settle(p, 1200);
  check(
    "moving shows the map with one pin",
    (await p.$$(".temp-pin.moving")).length === 1 && !(await p.isVisible("#sheet")),
  );
  await shot(p, "phone-11-moving");
  const mv = (await markers(p)).find((m) => m.key === "moving") as Marker;
  await t.swipe(mv.x, mv.y, mv.x + 70, mv.y - 90, 16);
  const mv2 = (await markers(p)).find((m) => m.key === "moving") as Marker;
  check("the pin follows the finger", Math.hypot(mv2.x - mv.x - 70, mv2.y - mv.y + 90) < 12, { mv, mv2 });
  await t.tapEl("#move-done");
  await settle(p, 600);
  check("the form is back", await p.isVisible("#f-save"));
  await p
    .waitForFunction(
      () => (document.querySelector(".p-address") as HTMLInputElement)?.value !== "Beispielallee 33, 30161 Hannover",
      undefined,
      { timeout: 3000 },
    )
    .catch(() => {});
  check(
    "the address follows the pin",
    (await p.inputValue(".p-address")).includes("Hannover"),
    await p.inputValue(".p-address"),
  );
  await shot(p, "phone-12-form-moved");
  await t.tapEl("#f-save");
  await settle(p, 700);
  const moved = await p.evaluate(async () => {
    const v = (await (await fetch(location.pathname.replace("/m/", "/api/m/"))).json()) as MapView;
    return v.entries.find((e) => e.name === "Hanna")?.places[0];
  });
  check("the move was saved", moved != null && moved.lat !== 52.3812, moved);

  // Deleting, undoing, the trash.
  await t.tapEl('[data-act="delete"]');
  await settle(p, 500);
  check("deleting returns to the list", (await state(p)).pane === "list");
  check("the toast offers undo", (await p.$eval("#toast", (e) => e.textContent ?? "")).includes("Hanna gelöscht"));
  await shot(p, "phone-13-deleted");
  await t.tapEl("#toast button");
  await settle(p, 600);
  const back = await p.evaluate(async () => {
    const v = (await (await fetch(location.pathname.replace("/m/", "/api/m/"))).json()) as MapView;
    return v.entries.some((e) => e.name === "Hanna");
  });
  check("undo brings the entry back", back);
  await t.swipe(195, 690, 195, 100);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>(".row .tap")].find((r) => r.textContent?.includes("Hanna"));
    row?.click();
  });
  await settle(p, 500);
  await t.tapEl('[data-act="delete"]');
  await settle(p, 500);
  await t.swipe(195, 690, 195, 100);
  await t.tapEl('[data-act="trash"]');
  await shot(p, "phone-14-trash");
  check("without the login the trash offers no delete for good", (await p.$$('[data-act="purge"]')).length === 0);
  await t.tapEl('[data-act="undelete"]');
  await settle(p, 500);
  check("the trash restores too", (await p.$$('[data-act="undelete"]')).length === 0);

  // An entry without a place: the row offers one.
  await p.evaluate(() => {
    const b = [...document.querySelectorAll<HTMLElement>('[data-act="add-place"]')][0];
    b?.click();
  });
  await settle(p, 400);
  check(
    "adding a place opens the form on it",
    await p.evaluate(() => !!document.activeElement?.classList.contains("p-address")),
  );
  await p.keyboard.type("Bahnhof");
  await p.waitForSelector(".sugg button");
  await shot(p, "phone-15-suggestions");
  check(
    "suggestions show the country abroad",
    (await p.$eval(".sugg button", (e) => e.textContent)) === "Bahnhofstrasse 1, 8001 Zürich, Schweiz",
  );
  await t.tapEl(".sugg button");
  check("a suggestion sets the position", (await p.$eval(".status", (e) => e.textContent)) === "Position gesetzt.");
  await p.fill(".p-address", "Nirgendwo 99");
  await p.waitForSelector(".sugg .hint");
  await t.tapEl("#f-name");
  await t.tapEl("#f-save");
  await settle(p, 400);
  check("a changed address does not save onto the old pin", await p.isVisible(".place-row.wrong"));
  await shot(p, "phone-29-address-changed");
  await t.tapEl('[data-act="keep"]');
  check(
    "the old position can be kept on purpose",
    (await p.$eval(".status", (e) => e.textContent)) === "Position gesetzt.",
  );
  await t.tapEl("#f-cancel");
  await settle(p, 500);
  const stillNone = await p.evaluate(async () => {
    const v = (await (await fetch(location.pathname.replace("/m/", "/api/m/"))).json()) as MapView;
    return v.entries.find((e) => e.name === "Gustav")?.places.length;
  });
  check("Abbrechen changes nothing", stillNone === 0);

  // An address without a position does not save silently. A full sheet covers the add button, its head has one.
  check(
    "the full sheet offers adding",
    (await state(p)).mode === "full" && (await p.isVisible(".add-chip")),
    await state(p),
  );
  await t.tapEl(".add-chip");
  await settle(p, 300);
  await p.keyboard.type("Ohne Ort");
  await t.tapEl(".p-address");
  await p.keyboard.type("Irgendwo 1");
  await t.tapEl("#f-save");
  await settle(p, 400);
  check("a place without a position stops the save", await p.isVisible("#f-save"));
  await shot(p, "phone-16-no-position");
  await p.reload();
  await settle(p, 800);
  await t.tapEl("#add");
  await settle(p, 300);
  check("a reload keeps the draft", (await p.inputValue("#f-name")) === "Ohne Ort", await p.inputValue("#f-name"));
  await t.tapEl("#f-cancel");
  await settle(p, 400);

  // Long press on the map.
  await settle(p, 400);
  await t.hold(150, 350);
  await p.waitForSelector(".address");
  await settle(p, 300);
  check("a long press opens that point", (await state(p)).pane === "address", await state(p));
  await shot(p, "phone-17-long-press");
  await t.tapEl('[data-act="close"]');
  await settle(p);
  check("closing removes the point", (await state(p)).pane === "list" && (await p.$$(".temp-pin")).length === 0);

  // Where am I, and the list by distance.
  await t.tapEl("#q-side");
  await settle(p, 1100);
  check("locating shows the blue dot", (await p.$$(".me-dot")).length === 1);
  await t.tapEl('[data-act="near"]');
  await t.swipe(195, 690, 195, 420);
  const first = await p.$eval(".row b", (e) => e.textContent);
  check("the nearest comes first", first === "Paula", first);
  check("rows show the distance", (await p.$$(".dist")).length >= 9);
  await shot(p, "phone-18-near");

  // A geocoder that drops requests now and then shows no error: the proxy and the page each try again.
  await t.tapEl("#q");
  await p.evaluate(() => {
    const body = document.querySelector("#sh-body") as HTMLElement;
    new MutationObserver(() => {
      if (body.textContent?.includes("nicht erreichbar")) (window as unknown as { sawDown: boolean }).sawDown = true;
    }).observe(body, { childList: true, subtree: true });
  });
  stack.geocoder.failNext = 2;
  await p.keyboard.type("Beispieldamm");
  await p.waitForSelector(".hit", { timeout: 6000 });
  check(
    "single failures stay out of sight",
    !(await p.evaluate(() => (window as unknown as { sawDown?: boolean }).sawDown)),
  );
  await t.tapEl("#q-side");
  await settle(p);

  // The geocoder down.
  stack.geocoder.failWith = 502;
  await t.tapEl("#q");
  await p.keyboard.type("Keine Antwort");
  await p.waitForFunction(
    () => document.querySelector("#sh-body")?.textContent?.includes("nicht erreichbar"),
    undefined,
    { timeout: 3000 },
  );
  check("a dead geocoder says so", true);
  await shot(p, "phone-19-geocoder-down");
  stack.geocoder.failWith = null;
  await t.tapEl("#q-side");
  await settle(p);
  check("the clear button leaves the search", !(await state(p)).searching, await state(p));

  // The note field stays put while iOS reports its keyboard, as in the note editor.
  await t.tapEl("#add");
  await settle(p, 300);
  await t.tapEl("#f-note");
  const field = () =>
    p.$eval("#f-note", (e) => {
      const t = e as HTMLTextAreaElement;
      return {
        value: t.value,
        start: t.selectionStart,
        docTop: Math.round(t.getBoundingClientRect().top + scrollY),
      };
    });
  let expected = "";
  for (const [top, h] of [
    [0, 464],
    [160, 464],
    [320, 464],
    [320, 844],
  ] as [number, number][]) {
    const batch = "Wir gingen heute lange durch den Wald.\n";
    await p.keyboard.type(batch);
    expected += batch;
    const before = await field();
    await p.evaluate(
      ([offsetTop, height]) => {
        const vv = window.visualViewport as VisualViewport;
        Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => offsetTop });
        Object.defineProperty(vv, "height", { configurable: true, get: () => height });
        vv.dispatchEvent(new Event("resize"));
        vv.dispatchEvent(new Event("scroll"));
      },
      [top, h],
    );
    await p.waitForTimeout(250);
    const after = await field();
    check(
      `typing: viewport ${top}/${h}: text, caret and field stay`,
      after.value === expected && after.start === expected.length && after.docTop === before.docTop,
      { before, after },
    );
  }
  await t.tapEl("#f-cancel");
  await settle(p, 400);

  // An address joins an existing entry.
  await t.tapEl("#q");
  await p.keyboard.type("Beispieldamm");
  await p.waitForSelector(".hit");
  await t.tapEl('[data-act="hit"]');
  await settle(p, 1000);
  await t.tapEl('[data-act="pick"]');
  await settle(p, 400);
  check(
    "the pick list fills the sheet",
    (await state(p)).pane === "pick" && (await state(p)).mode === "full",
    await state(p),
  );
  await shot(p, "phone-25-pick");
  await p.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-act="pick-entry"]')].find((r) =>
      r.textContent?.includes("Lena"),
    );
    row?.click();
  });
  await settle(p, 400);
  check(
    "the form keeps the entry's place and adds the new one",
    (await p.$$(".place-row")).length === 2 &&
      (await p.inputValue(".place-row:nth-child(2) .p-address")).startsWith("Beispieldamm"),
  );
  await t.tapEl(".place-row:nth-child(2) .p-label");
  await p.keyboard.type("Eltern");
  await t.tapEl("#f-save");
  await settle(p, 800);
  check("the entry now has both places", (await p.$$("#sheet .place")).length === 2);
  check("the temporary pin is gone after saving", (await p.$$(".temp-pin")).length === 0);
  await shot(p, "phone-26-two-places");

  // Back walks out of form and card, one step each.
  await t.tapEl('[data-act="edit"]');
  await p.goBack();
  await settle(p, 400);
  check(
    "back closes the form onto the card",
    (await state(p)).pane === "card" && !(await p.isVisible("#f-save")),
    await state(p),
  );
  await p.goBack();
  await settle(p, 400);
  check("back closes the card", (await state(p)).pane === "list" && (await state(p)).layers === 0, await state(p));
  await t.tapEl("#q");
  await p.goBack();
  await settle(p, 400);
  check("back closes the search", !(await state(p)).searching && (await state(p)).layers === 0, await state(p));

  // A tap on the map closes a card and leaves the page alone.
  await jump(p, 50.9, 6.6, 7);
  await settle(p, 600);
  const again = (await markers(p)).find((m) => m.key.startsWith("p:"));
  await t.tap((again as Marker).x, (again as Marker).y);
  await settle(p);
  await t.tap(330, 160);
  await settle(p);
  check("a tap on the map closes the card", (await state(p)).pane === "list", await state(p));

  // People at the very same spot: zooming cannot part them, so the cluster lists them.
  for (const name of ["Zwilling Eins", "Zwilling Zwei"])
    await stack.call("/api/admin/maps/freunde/entries", {
      method: "POST",
      admin: true,
      json: { name, places: [{ label: "", address: "Inselweg 1", lat: 49.5, lon: 8.1 }] },
    });
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await settle(p, 400);
  await jump(p, 49.5, 8.1, 16);
  await settle(p, 700);
  const twin = (await markers(p)).find((m) => m.key.startsWith("c:"));
  check("the same spot makes a cluster at any zoom", !!twin);
  await t.tap((twin as Marker).x, (twin as Marker).y);
  await settle(p, 500);
  check(
    "that cluster opens as a list",
    (await state(p)).pane === "group" && (await p.$$("#sheet .row")).length === 2,
    await state(p),
  );
  const above = await p
    .waitForFunction(() => (window as unknown as People).people.point(49.5, 8.1).y < 400, undefined, { timeout: 3000 })
    .catch(() => null);
  check("the cluster stays above the sheet", above != null);
  await shot(p, "phone-27-group");
  await t.tapEl('[data-act="close"]');
  await settle(p);

  // Own typing outranks the address of a moved pin; the location chip fills an empty row.
  await t.tapEl("#add");
  await settle(p, 300);
  await p.keyboard.type("Ort per Standort");
  await t.tapEl('[data-act="here"]');
  await p.waitForFunction(() => (document.querySelector(".p-address") as HTMLInputElement).value !== "", undefined, {
    timeout: 3000,
  });
  check("my location fills the address", (await p.$eval(".status", (e) => e.textContent)) === "Position gesetzt.");
  await p.fill(".p-address", "Mein eigener Text");
  await t.tapEl('[data-act="map"]');
  await settle(p, 900);
  await t.tapEl("#move-done");
  await settle(p, 700);
  check(
    "a moved pin leaves own text alone and offers its address",
    (await p.inputValue(".p-address")) === "Mein eigener Text" &&
      (await p.$$(".offer .chip")).length === 1 &&
      (await p.$eval(".status", (e) => e.textContent)) === "Position gesetzt.",
  );
  await shot(p, "phone-28-offer");
  await t.tapEl(".offer .chip");
  check("the offer can be taken", (await p.inputValue(".p-address")) !== "Mein eigener Text");
  await t.tapEl("#f-cancel");
  await settle(p, 400);

  // Safe areas: the notch and the home bar push the chrome in.
  await p.addStyleTag({ content: ":root{--sat:59px;--sab:34px}" });
  await settle(p);
  await shot(p, "phone-20-safe-areas");
  const safe = await p.evaluate(() => ({
    pill: document.querySelector("#search")?.getBoundingClientRect().top,
    body: (document.querySelector("#sheet") as HTMLElement).getBoundingClientRect().height,
  }));
  check("the pill clears the notch", (safe.pill ?? 0) >= 59, safe);
  check("the sheet grows by the home bar", safe.body === 168 + 34, safe);

  await ctx.close();
  check("no errors on the phone", errors.length === 0, errors.slice(0, 5));
}

// ---------------------------------------------------------------- the phone, read link
async function reader(browser: Browser, stack: Stack) {
  const ctx = await browser.newContext(phoneContext);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  const t = await Touch.on(ctx, p);
  await open(p, `${stack.base}/m/${stack.mapView}`);
  check("read link: the badge shows", await p.isVisible("#badge"));
  check("read link: no add button", (await p.$$("#add")).length === 0);
  check("read link: a share button without a menu", (await p.$$("#share")).length === 1 && !(await p.$("#share-menu")));
  await t.swipe(195, 690, 195, 420);
  await p.evaluate(() => (document.querySelector('[data-act="open"]') as HTMLElement).click());
  await settle(p);
  check(
    "read link: a card without edit and delete",
    (await p.$$('[data-act="edit"], [data-act="delete"]')).length === 0,
  );
  check("read link: the card keeps its links", (await p.$$("#sheet a.out")).length >= 3);
  await shot(p, "phone-21-read-only");
  const denied = await p.evaluate(async () => {
    const base = location.pathname.replace("/m/", "/api/m/");
    const res = await fetch(`${base}/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Eindringling" }),
    });
    return res.status;
  });
  check("read link: a write answers 403", denied === 403, denied);

  // A change by someone else arrives by itself.
  await p.goBack();
  await settle(p, 300);
  const add = await stack.call("/api/admin/maps/freunde/entries", {
    method: "POST",
    admin: true,
    json: { name: "Nachzügler", by: "Jemand" },
  });
  check("a change from elsewhere is saved", add.status === 201);
  await p.waitForFunction(() => document.querySelector("#sh-body")?.textContent?.includes("Nachzügler"), undefined, {
    timeout: 25_000,
  });
  check("the open page picks it up within one poll", true);
  await ctx.close();
  check("no errors on the read link", errors.length === 0, errors.slice(0, 5));
}

// ---------------------------------------------------------------- two editors
/** Two people on one write link: the latest write wins, nothing ever warns. */
async function twoEditors(browser: Browser, stack: Stack) {
  const open2 = async () => {
    const ctx = await browser.newContext(phoneContext);
    const p = await ctx.newPage();
    return { ctx, p, t: await Touch.on(ctx, p) };
  };
  const a = await open2();
  const b = await open2();
  const errors: string[] = [];
  const toasts: string[] = [];
  for (const { p } of [a, b]) {
    await watch(p, errors);
    await open(p, `${stack.base}/m/${stack.mapEdit}`);
    await p.exposeFunction("sawToast", (s: string) => toasts.push(s));
    await p.evaluate(() => {
      const t = document.querySelector("#toast") as HTMLElement;
      new MutationObserver(() =>
        (window as unknown as { sawToast(s: string): void }).sawToast(t.textContent ?? ""),
      ).observe(t, { childList: true, characterData: true, subtree: true });
    });
  }
  const server = async (name: string) => {
    const v = (await (await stack.call(`/api/m/${stack.mapEdit}`)).json()) as MapView;
    return v.entries.find((e) => e.name === name) as MapView["entries"][number];
  };
  const lena = await server("Lena");
  const edit = async (who: typeof a) => {
    await who.p.goto(`${stack.base}/m/${stack.mapEdit}?e=${lena.id}`);
    await who.p.waitForSelector('[data-act="edit"]');
    await settle(who.p, 700);
    await who.t.tapEl('[data-act="edit"]');
  };
  const poll = (p: Page) => p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  // Different fields: both stay, though both forms opened on the same state.
  await edit(a);
  await edit(b);
  await a.p.fill("#f-note", "Von A");
  await b.t.tapEl("#f-emoji");
  await b.p.keyboard.insertText("🌻");
  await a.t.tapEl("#f-save");
  await settle(a.p, 700);
  await b.t.tapEl("#f-save");
  await settle(b.p, 700);
  const both = await server("Lena");
  check("different fields: both changes stay", both.note === "Von A" && both.emoji === "🌻", both);

  // The same field: the later save wins.
  await edit(a);
  await edit(b);
  await a.p.fill("#f-note", "Erst A");
  await b.p.fill("#f-note", "Dann B");
  await a.t.tapEl("#f-save");
  await settle(a.p, 700);
  await b.t.tapEl("#f-save");
  await settle(b.p, 700);
  check("the same field: the later save wins", (await server("Lena")).note === "Dann B");

  // Places: one adds, the other edits another place; nothing is lost.
  const before = (await server("Lena")).places;
  await edit(a);
  await edit(b);
  await a.p.fill(".place-row .p-label", "Daheim");
  await b.t.tapEl("#f-add");
  await b.p.fill(".place-row:last-child .p-address", "Beispiel");
  await b.p.waitForSelector(".place-row:last-child .sugg button");
  await b.t.tapEl(".place-row:last-child .sugg button");
  await a.t.tapEl("#f-save");
  await settle(a.p, 700);
  await b.t.tapEl("#f-save");
  await settle(b.p, 700);
  const places = (await server("Lena")).places;
  check(
    "places: an edit and an added place both stay",
    places.length === before.length + 1 &&
      places[0]?.label === "Daheim" &&
      !!places.at(-1)?.address.startsWith("Beispielallee"),
    places,
  );

  // An open form follows what it has not changed, and keeps what it has.
  await edit(b);
  await b.p.fill("#f-name", "Lena L.");
  await stack.call(`/api/admin/maps/freunde/entries/${lena.id}`, {
    method: "PATCH",
    admin: true,
    json: { note: "Von woanders", name: "Lena M." },
  });
  await poll(b.p);
  await settle(b.p, 500);
  check("an open form takes in the other field", (await b.p.inputValue("#f-note")) === "Von woanders");
  check("and keeps the typing", (await b.p.inputValue("#f-name")) === "Lena L.");
  await b.t.tapEl("#f-save");
  await settle(b.p, 700);
  check("saving then keeps both", (await server("Lena L.")).note === "Von woanders");

  // A form nobody changed writes nothing.
  const rev = (await server("Lena L.")).rev;
  await edit(a);
  await stack.call(`/api/admin/maps/freunde/entries/${lena.id}`, {
    method: "PATCH",
    admin: true,
    json: { note: "Neuer" },
  });
  await a.t.tapEl("#f-save");
  await settle(a.p, 600);
  const after = await server("Lena L.");
  check(
    "an unchanged form saves nothing over the other's change",
    after.note === "Neuer" && after.rev === rev + 1,
    after,
  );

  // Saving what someone deleted meanwhile brings it back.
  await edit(a);
  await a.p.fill("#f-note", "Doch noch");
  await stack.call(`/api/admin/maps/freunde/entries/${lena.id}`, { method: "DELETE", admin: true });
  await a.t.tapEl("#f-save");
  await settle(a.p, 800);
  check("a save outlives a delete", (await server("Lena L."))?.note === "Doch noch");
  check("and says so quietly", (await a.p.$eval("#toast", (e) => e.textContent ?? "")).includes("ist wieder da"));
  check("its card opens", (await state(a.p)).pane === "card", await state(a.p));

  const warned = toasts.filter((s) => s && !/gespeichert|Rückgängig|wieder da/.test(s));
  check("nobody saw a warning", warned.length === 0, warned);
  check("no conflict UI exists", (await a.p.$$("#f-conflict, #f-mine, #f-theirs")).length === 0);
  await a.ctx.close();
  await b.ctx.close();
  check("no errors with two editors", errors.length === 0, errors.slice(0, 5));
}

// ---------------------------------------------------------------- an empty map, a long title
async function empty(browser: Browser, stack: Stack) {
  const res = await stack.call("/api/admin/maps", {
    method: "POST",
    admin: true,
    json: { slug: "leer", title: "Eine Karte mit einem wirklich sehr langen Namen, der nicht in die Kopfzeile passt" },
  });
  const made = (await res.json()) as MapCreated;
  const ctx = await browser.newContext(phoneContext);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  const t = await Touch.on(ctx, p);
  await open(p, `${stack.base}/m/${made.edit.token}`);
  check("an empty map invites", (await p.$eval(".empty", (e) => e.textContent ?? "")).startsWith("Noch niemand"));
  const wide = await p.$eval("#sh-head", (e) => e.scrollWidth - e.clientWidth);
  check("a long title stays in the head", wide <= 0, wide);
  await shot(p, "phone-23-empty");
  await t.tapEl("#add");
  await settle(p, 300);
  await p.keyboard.type(LONG_NAME);
  await t.tapEl("#f-save");
  await settle(p, 700);
  check("an entry without a place saves", (await state(p)).pane === "card", await state(p));
  await shot(p, "phone-24-long-name-card");
  check("no small tap targets on it", (await smallTargets(p)).length === 0, await smallTargets(p));
  await ctx.close();
  check("no errors on the empty map", errors.length === 0, errors.slice(0, 5));
}

// ---------------------------------------------------------------- the meeting point
async function meetPoint(browser: Browser, stack: Stack) {
  const open2 = async (token: string) => {
    const ctx = await browser.newContext(phoneContext);
    const p = await ctx.newPage();
    const errors: string[] = [];
    await watch(p, errors);
    await open(p, `${stack.base}/m/${token}`);
    return { ctx, p, errors, t: await Touch.on(ctx, p) };
  };
  const a = await open2(stack.mapEdit);
  const b = await open2(stack.mapEdit);
  const reader = await open2(stack.mapView);
  const entries = ((await (await stack.call(`/api/m/${stack.mapEdit}`)).json()) as MapView).entries;
  const id = (n: string) => (entries.find((e) => e.name === n) as MapView["entries"][number]).id;
  const poll = (p: Page) => p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const row = (n: string) => `[data-act="meet-toggle"][data-id="${id(n)}"]`;

  await a.t.tapEl("#meet");
  await settle(a.p, 700);
  check("the meeting point opens in the sheet", (await state(a.p)).pane === "meet", await state(a.p));
  check("with fewer than two nothing can be computed", await a.p.isDisabled(".meet-go"));
  await shot(a.p, "phone-40-meet-empty");

  for (const n of ["Paula", "Ida", "Wanda", "Tom & Vera"]) {
    await a.p.$eval(row(n), (e) => (e as HTMLElement).scrollIntoView({ block: "center" }));
    await a.t.tapEl(row(n));
    await settle(a.p, 200);
  }
  await a.t.tapEl(`[data-act="meet-mode"][data-id="${id("Paula")}"][data-mode="train"]`);
  await settle(a.p, 200);
  await a.t.tapEl(`[data-act="meet-mode"][data-id="${id("Ida")}"][data-mode="train"]`);
  await settle(a.p, 200);
  await a.t.tapEl(`[data-act="meet-weight"][data-id="${id("Wanda")}"][data-w="2"]`);
  await settle(a.p, 200);
  check(
    "the steps and the mode take",
    (await a.p.$eval(".meet-who span", (e) => e.textContent ?? "")).startsWith("4 von"),
  );
  check("no small tap targets in the selection", (await smallTargets(a.p)).length === 0, await smallTargets(a.p));
  check("nothing wider than the sheet", (await pageStill(a.p)).sheetWide <= 0, await pageStill(a.p));
  check("the middle shows beside it", (await a.p.$$(".meet-middle")).length === 1);
  await shot(a.p, "phone-41-meet-selected");

  // The second browser sees the selection without doing anything.
  await poll(b.p);
  await settle(b.p, 300);
  await b.t.tapEl("#meet");
  await settle(b.p, 500);
  check("another phone has the selection", (await b.p.$$('.check[aria-checked="true"]')).length === 4);

  await a.p.$eval("#sh-body", (e) => (e.scrollTop = 0));
  await a.t.tapEl(".meet-go");
  await a.p.waitForSelector(".meet-bar", { timeout: 3000 });
  await shot(a.p, "phone-42-meet-running");
  await a.p.waitForSelector(".meet-best", { timeout: 20_000 });
  await settle(a.p, 500);
  check("the result arrives", ((await a.p.$eval(".meet-best", (e) => e.textContent)) ?? "").startsWith("1. "));
  check("three stars and lines", (await a.p.$$(".meet-star")).length === 3);
  check("non-members fade", (await a.p.$$(".pin.dim")).length > 0);
  check("each member has a time", (await a.p.$$(".meet-row .time")).length === 4);
  await shot(a.p, "phone-43-meet-result");

  await poll(b.p);
  await b.p.waitForSelector(".meet-best", { timeout: 6000 });
  check("the other phone has the result without a click", true);
  await a.t.tapEl('[data-act="meet-pick"][data-i="1"]');
  await settle(a.p, 300);
  check(
    "another candidate can be looked at",
    ((await a.p.$eval(".meet-best", (e) => e.textContent)) ?? "").startsWith("2. "),
  );
  await a.t.tapEl('[data-act="meet-pick"][data-i="0"]');
  await settle(a.p, 300);

  await a.p.$eval(`[data-act="meet-weight"][data-id="${id("Wanda")}"][data-w="3"]`, (e) =>
    (e as HTMLElement).scrollIntoView({ block: "center" }),
  );
  await a.t.tapEl(`[data-act="meet-weight"][data-id="${id("Wanda")}"][data-w="3"]`);
  await settle(a.p, 300);
  await a.p.$eval("#sh-body", (e) => (e.scrollTop = 0));
  check(
    "a change marks the result",
    ((await a.p.$eval(".meet-stale", (e) => e.textContent)) ?? "").includes("Wanda 2→3"),
  );
  await shot(a.p, "phone-44-meet-stale");
  await poll(b.p);
  await b.p.waitForSelector(".meet-stale", { timeout: 4000 });
  check("on the other phone too", true);

  await reader.t.tapEl("#meet");
  await settle(reader.p, 600);
  check("the read link shows the result", (await reader.p.$$(".meet-best")).length === 1);
  check("and offers no controls", (await reader.p.$$(".meet-go, .meet-mode, .meet-step, .check[role]")).length === 0);
  await shot(reader.p, "phone-45-meet-read-only");

  await a.t.tapEl('[data-act="close"]');
  await settle(a.p);
  check("closing clears the stars", (await a.p.$$(".meet-star, .meet-middle, .pin.dim")).length === 0);

  // A picture: tap the face, choose a file, see it on the card and the pin; undo.
  await a.p.goto(`${stack.base}/m/${stack.mapEdit}?e=${id("Paula")}`);
  await a.p.waitForSelector('[data-act="avatar"]');
  await settle(a.p, 700);
  await a.t.tapEl('[data-act="avatar"]');
  await settle(a.p, 300);
  await shot(a.p, "phone-46-avatar-chooser");
  check("no small tap targets in the chooser", (await smallTargets(a.p)).length === 0, await smallTargets(a.p));
  const picture = await a.p.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 900;
    const x = c.getContext("2d") as CanvasRenderingContext2D;
    x.fillStyle = "#0ea5e9";
    x.fillRect(0, 0, 1600, 900);
    x.fillStyle = "#fde047";
    x.beginPath();
    x.arc(800, 450, 300, 0, 7);
    x.fill();
    return c.toDataURL("image/png").split(",")[1] as string;
  });
  await a.p.setInputFiles("#avatar-file", {
    name: "foto.png",
    mimeType: "image/png",
    buffer: Buffer.from(picture, "base64"),
  });
  await a.p.waitForSelector('[data-act="avatar-save"]');
  await shot(a.p, "phone-47-avatar-preview");
  await a.t.tapEl('[data-act="avatar-save"]');
  await settle(a.p, 700);
  const paula = () =>
    stack.call(`/api/m/${stack.mapEdit}/entries/${id("Paula")}`).then((r) => r.json()) as Promise<
      MapView["entries"][number]
    >;
  const pic = (await paula()).avatar;
  check("the picture is saved", !!pic);
  const res = await stack.call(`/api/m/${stack.mapView}/avatar/${pic}`);
  check(
    "as a small JPEG",
    res.headers.get("content-type") === "image/jpeg" && (await res.arrayBuffer()).byteLength < 131072,
  );
  check("the card shows it", (await a.p.$$(".sh-head .av img")).length === 1);
  check("the pin shows it", (await a.p.$$(".pin.sel img")).length === 1);
  await a.p.waitForFunction(() => {
    const i = document.querySelector<HTMLImageElement>(".pin.sel img");
    return i?.complete && i.naturalWidth > 0;
  });
  await shot(a.p, "phone-48-avatar-saved");
  await a.t.tapEl("#toast button");
  await settle(a.p, 500);
  check("undo takes it back", (await paula()).avatar === null);

  await a.t.tapEl('[data-act="avatar"]');
  await settle(a.p, 300);
  await a.t.tapEl("#avatar-emoji");
  await a.p.keyboard.insertText("🦔");
  await a.t.tapEl('[data-act="avatar-emoji"]');
  await settle(a.p, 500);
  check("an emoji can be chosen there", (await paula()).emoji === "🦔");
  await a.t.tapEl('[data-act="avatar"]');
  await settle(a.p, 300);
  await a.p.setInputFiles("#avatar-file", {
    name: "kaputt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("nicht lesbar"),
  });
  await settle(a.p, 500);
  check("an unreadable file says so", (await a.p.$eval("#toast", (e) => e.textContent ?? "")).includes("Bildformat"));
  await a.t.tapEl('[data-act="avatar-clear"]');
  await settle(a.p, 500);
  check("back to initials", (await paula()).emoji === null);

  for (const x of [a, b, reader]) {
    await x.ctx.close();
    check("no errors on the meeting point", x.errors.length === 0, x.errors.slice(0, 5));
  }
}

// ---------------------------------------------------------------- browsers that cannot
async function deadMap(stack: Stack) {
  // Without WebGL the list works on its own.
  const plain = await chromium.launch({ executablePath: chromiumPath(), args: ["--disable-3d-apis"] });
  const ctx = await plain.newContext(phoneContext);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await p.goto(`${stack.base}/m/${stack.mapView}`);
  await p.waitForSelector(".row");
  await settle(p, 400);
  const webgl = await p.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  check("this browser really has no WebGL 2", !webgl);
  check("without WebGL the list opens", (await state(p)).mode === "half", await state(p));
  await shot(p, "phone-30-no-webgl");
  await p.evaluate(() => (document.querySelector('[data-act="open"]') as HTMLElement).click());
  await settle(p);
  check("and a card with its links", (await p.$$("#sheet a.out")).length >= 3);
  check("no errors without WebGL", errors.length === 0, errors.slice(0, 5));

  // A bundle that dies before its first line, as on an old Safari.
  const q = await ctx.newPage();
  await q.route("**/assets/main-*.js", (r) => r.abort());
  await q.goto(`${stack.base}/m/${stack.mapView}`);
  await settle(q, 300);
  check(
    "a dead bundle leaves a sentence",
    (await q.$eval("#sheet", (e) => e.textContent ?? "")).includes("startet nicht"),
  );
  await shot(q, "phone-31-dead-bundle");
  await plain.close();
}

// ---------------------------------------------------------------- the desktop
async function desktop(browser: Browser, stack: Stack) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await open(p, `${stack.base}/m/${stack.mapEdit}`);
  await shot(p, "desktop-01-start");
  const panel = await p.$eval("#sheet", (e) => e.getBoundingClientRect().toJSON());
  check("the panel stands on the right", panel.right === 1424 && panel.width === 380, panel);
  await p.keyboard.press("/");
  check("/ focuses the search", await p.evaluate(() => document.activeElement?.id === "q"));
  await p.keyboard.type("Hann");
  await settle(p);
  await shot(p, "desktop-02-search");
  await p.keyboard.press("Escape");
  await settle(p);
  check("Esc leaves the search", !(await state(p)).searching);
  await p.keyboard.press("ArrowDown");
  await settle(p);
  check("arrow keys step through the entries", (await state(p)).pane === "card", await state(p));
  await shot(p, "desktop-03-card");
  await p.keyboard.press("Escape");
  await settle(p);
  check("Esc closes the card", (await state(p)).pane === "list");
  await p.click("#add");
  await settle(p, 300);
  await shot(p, "desktop-04-form");
  await p.click("#f-cancel");
  await settle(p, 300);
  await ctx.close();
  check("no errors on the desktop", errors.length === 0, errors.slice(0, 5));
}

const stack = await startStack(0);
const browser = await chromium.launch({ executablePath: chromiumPath(), args: webglArgs });
try {
  await phone(browser, stack);
  await reader(browser, stack);
  await twoEditors(browser, stack);
  await empty(browser, stack);
  await desktop(browser, stack);
  await meetPoint(browser, stack);
  await deadMap(stack);
} catch (e) {
  check("the run finished", false, e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
  stack.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
