#!/usr/bin/env bun
// Drives the built client on a phone (390×844, touch) and a desktop (1440×900) against the sample
// trip on a fake Immich, checks the interactions, and saves screenshots:
//   bun run build && bun e2e/selftest.ts [out-dir]
// Needs a Chromium: see e2e/browsers.ts.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import type { TripView } from "../src/shared/api";
import { isoInZone } from "../src/shared/time";
import { onTrack } from "../test/helpers";
import { chromiumPath } from "./browsers";
import { playProxy, type Stack, startStack } from "./stack";

/** The spot beside day 2's track where the editing checks place and move notes (`T`, `T + d` in degrees). */
const T = onTrack(2, 0.4);
const beside = (dLat: number, dLon: number) => ({ lat: +(T.lat + dLat).toFixed(6), lon: +(T.lon + dLon).toFixed(6) });

const out = process.argv[2] ?? join(homedir(), ".tmp", "trip-diary-selftest");
await mkdir(out, { recursive: true });

const results: { ok: boolean; name: string; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  results.push({ ok, name, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
  );
}

interface State {
  selected: string | null;
  mode: string;
  zoom: number;
  center: { lat: number; lng: number };
  layers: number;
}
const state = (p: Page) => p.evaluate(() => (window as unknown as { trip: { state(): State } }).trip.state());
const keys = (p: Page) => p.evaluate(() => (window as unknown as { trip: { keys(): string[] } }).trip.keys());
const shot = (p: Page, name: string) => p.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 70 });
const settle = (p: Page, ms = 350) => p.waitForTimeout(ms);
const chip = (key: string) => `#strip [data-key="${key}"]`;

/** The pin's screen position and the free band of the map, to check "visible" the way the app means it. */
async function pinInBand(p: Page, key: string) {
  return p.evaluate((k) => {
    const t = (window as unknown as { trip: { band(): { top: number; bottom: number; left: number; right: number } } })
      .trip;
    const pin = [...document.querySelectorAll<HTMLElement>(".pin.sel, .flag.sel")][0];
    if (!pin) return { ok: false, why: `no selected pin for ${k}` };
    const r = pin.getBoundingClientRect();
    const b = t.band();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return { ok: x > b.left && x < b.right && y > b.top && y < b.bottom, x, y, b };
  }, key);
}

/** How far each pin's visible point (a teardrop's tip, a round pin's or a flag's centre) lies from its own spot, in px. */
async function pinErrors(p: Page) {
  return p.evaluate(() => {
    const t = (window as unknown as { trip: { pinPoints(): { key: string; x: number; y: number }[] } }).trip;
    return t.pinPoints().map(({ key, x, y }) => {
      const e = document.querySelector<HTMLElement>(`[data-pin="${key}"]`) as HTMLElement;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      const tear = e.classList.contains("pin") && cs.borderBottomLeftRadius !== cs.borderTopLeftRadius;
      const vx = r.left + r.width / 2;
      const vy = tear ? r.bottom : r.top + r.height / 2;
      return { key, d: Math.round(Math.hypot(vx - x, vy - y)) };
    });
  });
}

/** The trip as the page's own token sees it. */
const tripView = (p: Page) =>
  p.evaluate(async () => (await (await fetch(`/api/t/${location.pathname.slice(1)}`)).json()) as TripView);

async function watch(p: Page, errors: string[]) {
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" && !/opentopomap|ERR_|Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });
  p.on("dialog", (d) => void d.accept());
}

async function open(p: Page, url: string) {
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForSelector(`${chip("trip")}`);
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

/**
 * The headless shell cannot decode video, so playback is replaced by a model of it: play() and
 * pause() flip `paused`, fire the events a browser would, and are logged as `play:<media id>:muted=<bool>`.
 * `__refuseSound` makes unmuted play() fail as a browser without a fresh tap does; `__end(el)` ends a video.
 */
const MEDIA_STUB = `(() => {
  const state = new WeakMap();
  const log = [];
  const id = (el) => (el.getAttribute("src") || "").match(/\\/m\\/(\\d+)\\//)?.[1];
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return state.get(this) ?? true; } });
  HTMLMediaElement.prototype.play = function () {
    if (window.__refuseSound && !this.muted) return Promise.reject(new DOMException("no gesture", "NotAllowedError"));
    state.set(this, false);
    log.push("play:" + id(this) + ":muted=" + this.muted);
    queueMicrotask(() => { this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); });
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function () {
    if (this.paused) return;
    state.set(this, true);
    log.push("pause:" + id(this));
    queueMicrotask(() => this.dispatchEvent(new Event("pause")));
  };
  window.__end = (el) => { state.set(el, true); el.dispatchEvent(new Event("pause")); el.dispatchEvent(new Event("ended")); };
  window.__vlog = log;
})();`;
const vlog = (p: Page) => p.evaluate(() => (window as unknown as { __vlog: string[] }).__vlog.slice());
const stored = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem("trip-video") ?? "null"));
const sw = (name: string) => `.vsw [data-vsw="${name}"]`;
const pressed = (p: Page, name: string) => p.getAttribute(sw(name), "aria-pressed");
const tilePlaying = (p: Page, i: number) =>
  p.$eval(`.media .m[data-i="${i}"]`, (e) => e.classList.contains("playing")).catch(() => false);

async function phoneReadOnly(browser: Browser, url: string) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(MEDIA_STUB);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await open(p, url);
  await shot(p, "phone-01-overview");
  const card = await p.$eval(chip("trip"), (c) => {
    const t = c.querySelector(".t") as HTMLElement;
    const r = c.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const rows = [...c.children].map((x) => x.getBoundingClientRect());
    const overlap = rows.some((a, i) => rows.some((b, j) => j > i && a.bottom > b.top + 1 && b.bottom > a.top + 1));
    return {
      text: t.textContent,
      clipped: t.scrollHeight > t.clientHeight + 1 || t.scrollWidth > t.clientWidth + 1,
      inside: tr.bottom <= r.bottom + 1,
      overlap,
    };
  });
  check(
    "a long trip title is readable in full on the trip card",
    card.text === "Beispielwanderung Mittelgebirge @Anna" && !card.clipped && card.inside && !card.overlap,
    card,
  );
  check("the page title is the full trip title", (await p.title()) === "Beispielwanderung Mittelgebirge @Anna");

  const order = await keys(p);
  check(
    "strip orders by time, not number (6 before 2, 2 before day end 1, day 1 before note 3)",
    order.indexOf("6") < order.indexOf("2") &&
      order.indexOf("2") < order.indexOf("d1") &&
      order.indexOf("d1") < order.indexOf("3"),
    order,
  );
  const chips = await p.$$eval("#strip .chip", (els) => els.map((e) => (e as HTMLElement).dataset.key));
  check(
    "strip shows the trip card and every note",
    chips[0] === "trip" && chips.length === order.length + 1,
    chips.length,
  );
  const widths = await p.$$eval("#strip .chip:not(.trip)", (els) =>
    els.slice(0, 3).map((e) => e.getBoundingClientRect().width),
  );
  check(
    "note chips are a third of a phone width each",
    widths.every((w) => w > 100 && w <= 390 / 3),
    widths,
  );

  await p.tap(chip("6"));
  await settle(p);
  let s = await state(p);
  check("tapping a chip selects the note and opens the sheet half", s.selected === "6" && s.mode === "half", s);
  check(
    "the chip and the pin are highlighted",
    (await p.$eval(chip("6"), (e) => e.classList.contains("sel"))) &&
      (await p.$eval(".pin.sel span", (e) => e.textContent)) === "6",
  );
  check("the selected pin lies in the free band", (await pinInBand(p, "6")).ok, await pinInBand(p, "6"));
  check("three photos in the sheet", (await p.$$(".media .m")).length === 3);
  await shot(p, "phone-02-note-half");

  await p.tap(chip("2"));
  await settle(p);
  s = await state(p);
  check("the strip stays usable while a note is open", s.selected === "2" && s.mode === "half", s);
  check(
    "a note without photos renders its text",
    (await p.$$(".media .m")).length === 0 && (await p.textContent(".entry"))?.includes("Lagerplatz") === true,
  );

  // Far away at zoom 14: selecting pans to the note, keeping the zoom.
  const farPoint = onTrack(5, 0.95);
  const last = await p.evaluate((f) => {
    const t = (window as unknown as { trip: { setView(a: number, b: number, z: number): void } }).trip;
    t.setView(f.lat, f.lon, 14);
    return true;
  }, farPoint);
  await settle(p, 200);
  const before = await state(p);
  await p.tap(chip("1"));
  await p.waitForTimeout(700);
  s = await state(p);
  check(
    "a note outside the band pans the map there at the same zoom",
    last &&
      s.selected === "1" &&
      s.zoom === 14 &&
      s.zoom === before.zoom &&
      Math.abs(s.center.lat - before.center.lat) > 0.01,
    { before, after: s },
  );
  check("…and its pin is then in the band", (await pinInBand(p, "1")).ok, await pinInBand(p, "1"));
  await shot(p, "phone-03-far-note-panned");

  // Already visible: select only.
  await p.tap("#s-close");
  await settle(p);
  const c0 = (await state(p)).center;
  await p.tap(chip("1"));
  await settle(p, 500);
  s = await state(p);
  check(
    "a note already in the band is selected without moving the map",
    s.selected === "1" && Math.abs(s.center.lat - c0.lat) < 1e-6 && Math.abs(s.center.lng - c0.lng) < 1e-6,
    { c0, s },
  );

  await p.tap(chip("1"));
  await settle(p);
  s = await state(p);
  check("tapping the selected chip hides the sheet to a peek bar", s.mode === "peek" && s.selected === "1", s);
  await shot(p, "phone-04-peek");
  await p.tap(chip("1"));
  await settle(p);
  check("tapping it again brings the sheet back", (await state(p)).mode === "half");

  await p.tap("#s-title");
  await settle(p);
  s = await state(p);
  check("tapping the sheet header opens it full", s.mode === "full", s);
  const stripVisible = await p.$eval("#strip", (e) => e.getBoundingClientRect().bottom > 40);
  await shot(p, "phone-05-full");
  await p.tap(chip("3"));
  await settle(p);
  s = await state(p);
  check(
    "full stays full when jumping to another note from the strip",
    stripVisible && s.selected === "3" && s.mode === "full",
    s,
  );

  const order2 = await keys(p);
  await p.tap("#s-next");
  await settle(p);
  s = await state(p);
  check("› goes to the next note in timeline order", s.selected === order2[order2.indexOf("3") + 1], {
    s,
    want: order2[order2.indexOf("3") + 1],
  });
  await p.tap("#s-prev");
  await settle(p);
  check("‹ goes back", (await state(p)).selected === "3");

  await p.tap("#s-close");
  await settle(p);
  s = await state(p);
  check(
    "✕ deselects everything",
    s.selected === null &&
      s.mode === "closed" &&
      (await p.$$("#strip .chip.sel")).length === 0 &&
      (await p.$$(".pin.sel")).length === 0,
    s,
  );

  await p.tap(chip("d3"));
  await settle(p);
  check(
    "a day end shows stats and the elevation profile",
    (await p.$$(".stats div")).length === 6 && (await p.$$(".profile polyline")).length === 1,
  );
  check("the day end is labelled by its camp", (await p.textContent("#s-title")) === "Wildcamp Tag 3");
  await shot(p, "phone-06-day-end");

  // Viewer across notes: last photo of note 6, then onward into the next note with media.
  await p.tap(chip("6"));
  await settle(p);
  await p.tap('.media .m[data-i="2"]');
  await p.waitForSelector(".pswp--open", { timeout: 5000 });
  await p.waitForTimeout(600);
  check(
    "the viewer opens on the tapped photo",
    (await p.textContent(".pswp__cap small"))?.includes("3 von 3") === true,
    await p.textContent(".pswp__cap small"),
  );
  await shot(p, "phone-07-viewer");
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(500);
  const pill = await p.textContent(".pswp__note");
  check("swiping past a note's last photo continues with the next note's", pill?.trim().startsWith("3") === true, pill);
  await shot(p, "phone-08-viewer-crossed");
  await p.keyboard.press("Escape");
  await settle(p, 500);
  s = await state(p);
  check(
    "closing the viewer lands on the note owning the photo",
    s.selected === "3" && s.mode === "half" && (await p.$eval(chip("3"), (e) => e.classList.contains("sel"))),
    s,
  );

  // ---- videos play inline, with switches kept in the browser
  await p.tap(chip("5"));
  await settle(p);
  check(
    "a video shows play and duration in the sheet",
    (await p.$$(".media .m .play")).length === 1 && (await p.textContent(".media .dur")) === "0:14",
  );
  let log = await vlog(p);
  check(
    "opening a note with autoplay on (the default) starts its video inline and muted, not full screen",
    log.length === 1 && log[0]?.endsWith(":muted=true") === true && (await p.$(".pswp--open")) === null,
    log,
  );
  check(
    "a single video plays once, and the switches show their defaults without anything stored",
    !(await p.$eval(".media .m.vid video", (v) => (v as HTMLVideoElement).loop)) &&
      (await pressed(p, "autoplay")) === "true" &&
      (await pressed(p, "mute")) === "true" &&
      (await pressed(p, "loop")) === "false" &&
      (await stored(p)) === null,
  );
  await shot(p, "phone-09-video-inline");
  await p.tap(".media .m.vid .pp");
  check(
    "tapping the playing video pauses it inline",
    !(await tilePlaying(p, 0)) && (await vlog(p)).at(-1)?.startsWith("pause:") === true,
  );
  await p.tap(".media .m.vid .pp");
  check("tapping it again plays it inline", (await tilePlaying(p, 0)) && (await p.$(".pswp--open")) === null);

  await p.tap(sw("mute"));
  check(
    "the mute switch unmutes the playing video and is stored",
    (await pressed(p, "mute")) === "false" &&
      !(await p.$eval(".media .m.vid video", (v) => (v as HTMLVideoElement).muted)) &&
      (await stored(p))?.mute === false,
    await stored(p),
  );
  await p.tap(sw("loop"));
  check(
    "the repeat switch makes the single video loop and is stored",
    (await pressed(p, "loop")) === "true" &&
      (await p.$eval(".media .m.vid video", (v) => (v as HTMLVideoElement).loop)) &&
      (await stored(p))?.loop === true,
  );
  await p.tap(sw("loop"));
  check("and off again", !(await p.$eval(".media .m.vid video", (v) => (v as HTMLVideoElement).loop)));
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await p.keyboard.press("Space");
  check("the space bar pauses the note's video", !(await tilePlaying(p, 0)));
  await p.keyboard.press("Space");
  check("and plays it again", await tilePlaying(p, 0));

  // Note 10: video, photo, video.
  await p.tap(chip("10"));
  await settle(p);
  const ids10 = await p.$$eval(".media .m", (els) => els.map((e) => e.classList.contains("vid")));
  log = await vlog(p);
  check(
    "the switches carry over to the next note: its video starts unmuted, and the first of two plays first",
    ids10.join() === "true,false,true" &&
      (await tilePlaying(p, 0)) &&
      !(await tilePlaying(p, 2)) &&
      log.at(-1)?.endsWith(":muted=false") === true &&
      (await pressed(p, "mute")) === "false",
    { ids10, log },
  );
  check(
    "videos of a note with several do not loop",
    !(await p.$eval('.media .m[data-i="0"] video', (v) => (v as HTMLVideoElement).loop)),
  );
  await p.evaluate(() => {
    const w = window as unknown as { __end(el: Element): void };
    w.__end(document.querySelector('.media .m[data-i="0"] video') as Element);
  });
  await settle(p, 900);
  const row = await p.$eval(".media", (e) => ({ left: e.scrollLeft, max: e.scrollWidth - e.clientWidth }));
  check(
    "when the first video ends the second one plays, the photo between skipped, and the row scrolls to it",
    (await tilePlaying(p, 2)) && !(await tilePlaying(p, 0)) && row.left > 100,
    row,
  );
  await shot(p, "phone-09b-video-sequence");
  await p.evaluate(() => {
    const w = window as unknown as { __end(el: Element): void };
    w.__end(document.querySelector('.media .m[data-i="2"] video') as Element);
  });
  await settle(p, 900);
  check(
    "after the last video nothing starts again while repeat is off",
    !(await tilePlaying(p, 0)) && !(await tilePlaying(p, 2)),
  );
  await p.tap(sw("loop"));
  await p.tap('.media .m[data-i="2"] .pp');
  await p.evaluate(() => {
    const w = window as unknown as { __end(el: Element): void };
    w.__end(document.querySelector('.media .m[data-i="2"] video') as Element);
  });
  await settle(p, 900);
  check(
    "with repeat on, after the last video the first starts again",
    (await tilePlaying(p, 0)) && !(await tilePlaying(p, 2)),
  );
  await p.tap(sw("loop"));

  // The full-screen button: sound whatever the mute switch says, space, starting on arrival.
  await p.tap(sw("mute"));
  check("mute switched on again", (await pressed(p, "mute")) === "true");
  await p.tap('.media .m[data-i="0"] .fs');
  await p.waitForSelector(".pswp--open", { timeout: 5000 });
  await settle(p, 400);
  log = await vlog(p);
  const viewerVideo = (i: number) =>
    p.evaluate((n) => document.querySelectorAll(".pswp video")[n]?.getAttribute("src"), i);
  check(
    "the full-screen button opens the viewer on that video, which starts with sound despite the mute switch",
    log.at(-1)?.endsWith(":muted=false") === true && !(await tilePlaying(p, 0)) && !!(await viewerVideo(0)),
    log.slice(-3),
  );
  await shot(p, "phone-09c-video-viewer");
  await p.keyboard.press("Space");
  check(
    "space pauses it in the viewer",
    (await vlog(p)).at(-1)?.startsWith("pause:") === true,
    (await vlog(p)).slice(-2),
  );
  await p.keyboard.press("Space");
  check("and plays it again", (await vlog(p)).at(-1)?.endsWith(":muted=false") === true);
  const n0 = (await vlog(p)).length;
  await p.keyboard.press("ArrowRight");
  await settle(p, 500);
  await p.keyboard.press("ArrowRight");
  await settle(p, 500);
  log = await vlog(p);
  check(
    "moving to the next video starts it with sound and pauses the one left",
    log.slice(n0).some((l) => l.startsWith("pause:")) && log.at(-1)?.endsWith(":muted=false") === true,
    log.slice(n0),
  );
  await p.keyboard.press("Escape");
  await settle(p);

  // A browser that refuses sound without a tap: muted instead, and the switch says so.
  await p.evaluate(() => {
    (window as unknown as { __refuseSound: boolean }).__refuseSound = true;
  });
  await p.tap(sw("mute"));
  await p.tap(chip("5"));
  await settle(p);
  log = await vlog(p);
  check(
    "a refused unmuted start falls back to muted, shows the mute switch on, and keeps the stored choice",
    log.at(-1)?.endsWith(":muted=true") === true &&
      (await pressed(p, "mute")) === "true" &&
      (await stored(p))?.mute === false,
    { log: log.slice(-2), stored: await stored(p) },
  );
  await p.evaluate(() => {
    (window as unknown as { __refuseSound: boolean }).__refuseSound = false;
  });

  // Autoplay off: remembered, and the next note stays quiet until play is tapped.
  await p.tap(sw("autoplay"));
  await p.tap(chip("10"));
  await settle(p);
  const n1 = (await vlog(p)).length;
  check(
    "with autoplay off a note's videos wait: stored, nothing plays",
    (await pressed(p, "autoplay")) === "false" &&
      (await stored(p))?.autoplay === false &&
      !(await tilePlaying(p, 0)) &&
      !(await tilePlaying(p, 2)),
  );
  await p.tap('.media .m[data-i="2"] .pp');
  check("tapping play then plays that video inline", (await tilePlaying(p, 2)) && (await vlog(p)).length === n1 + 1);
  await p.tap(chip("5"));
  await settle(p);
  check("autoplay stays off on the next note", !(await tilePlaying(p, 0)));
  await p.tap(sw("autoplay"));
  check("turning autoplay on starts the note's video", await tilePlaying(p, 0));

  // A refreshed view of the same note leaves its video playing.
  await stack.call("/api/admin/trips/sample/notes/5", {
    method: "PATCH",
    admin: true,
    json: { text: "Neuer Text vom Aussichtspunkt." },
  });
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForFunction(() => document.querySelector(".entry")?.textContent?.includes("Neuer Text"), null, {
    timeout: 5000,
  });
  check("a refreshed view of the same note keeps its video playing", await tilePlaying(p, 0));
  await p.tap(chip("3"));
  await settle(p);
  check("a note without videos has no switches", (await p.$(".vsw")) === null);

  // Back closes layers instead of leaving the page.
  await p.tap(chip("4"));
  await settle(p);
  await p.goBack();
  await settle(p, 500);
  s = await state(p);
  check(
    "browser back closes the sheet and stays on the trip",
    s.selected === null && new URL(p.url()).pathname.length > 20,
    { s, url: p.url() },
  );

  await open(p, `${url}?n=8`);
  await settle(p, 500);
  check("a ?n= link opens that note", (await state(p)).selected === "8");

  check("read-only: no add button", (await p.$("#add")) === null);
  const write = await p.evaluate(
    async () => (await fetch(`/api/t/${location.pathname.slice(1)}/notes`, { method: "POST", body: "{}" })).status,
  );
  check("read-only: writes are refused", write === 403, write);
  await open(p, url);
  await settle(p, 500);
  // Every pin stays on its spot, at the whole-trip zoom as when zoomed in.
  const far = (await pinErrors(p)).filter((e) => e.d > 3);
  check("overview: every pin sits on its own spot", far.length === 0, far);
  await shot(p, "phone-10-overview-pins");
  const pinsAt = onTrack(1, 0.3);
  await p.evaluate(
    (c) =>
      (window as unknown as { trip: { setView(a: number, b: number, z: number): void } }).trip.setView(
        c.lat,
        c.lon,
        14,
      ),
    pinsAt,
  );
  await settle(p, 600);
  const near = (await pinErrors(p)).filter((e) => e.d > 3);
  check("zoomed in: every pin sits on its own spot", near.length === 0, near);
  await shot(p, "phone-11-zoomed-pins");
  await p.tap(chip("6"));
  await settle(p);
  check("a row of several photos shows their count", (await p.textContent(".media .count"))?.trim() === "3");
  const c11 = (await state(p)).center;
  await p.tap(chip("11"));
  await settle(p, 500);
  const o11 = await keys(p);
  check(
    "a note without a place: no pin, the map stays, the sheet says so, the strip puts it in the evening of day 3",
    (await state(p)).selected === "11" &&
      !(await p.$(".pin.sel")) &&
      !(await p.$('[data-pin="11"]')) &&
      Math.abs((await state(p)).center.lat - c11.lat) < 1e-6 &&
      ((await p.textContent(".meta")) ?? "").includes("ohne Ort") &&
      !(await p.$(".meta .when")) &&
      o11.indexOf("d3") < o11.indexOf("11") &&
      o11.indexOf("11") < o11.indexOf("8"),
    o11,
  );
  await shot(p, "phone-12-no-place");
  await p.tap(chip("12"));
  await settle(p);
  const hostile = await p.evaluate(() => {
    const e = document.querySelector(".entry") as HTMLElement;
    return {
      style: e.querySelectorAll("style, form, input, button, textarea, select").length,
      ids: e.querySelectorAll("[id], [style], [name]").length,
      text: e.textContent?.includes("Harmlos") ?? false,
      outline: getComputedStyle(document.body).outlineStyle,
    };
  });
  check(
    "note markdown cannot restyle the page or plant forms and ids",
    hostile.style === 0 && hostile.ids === 0 && hostile.text && hostile.outline === "none",
    hostile,
  );
  check("phone: no page errors", errors.length === 0, errors);
  await ctx.close();
}

async function phoneEdit(browser: Browser, stack: Stack, url: string, friendsUrl: string) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const proxy = await playProxy(ctx, stack.editBase);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await open(p, url);
  await p.waitForSelector("#add", { timeout: 8000 });
  await settle(p, 600);
  await shot(p, "edit-01-map");
  check("edit mode is shown by a badge", await p.isVisible("#edit-badge"));
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("#add", { state: "attached", timeout: 8000 });
  check("edit mode survives a reload", await p.isVisible("#edit-badge"));
  await p.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    navigator.clipboard.writeText = async (t: string) => {
      (window as unknown as { copied: string[] }).copied.push(t);
    };
  });
  await p.tap("#share");
  await settle(p, 200);
  const copied = await p.evaluate(() => (window as unknown as { copied: string[] }).copied);
  check("the share button hands out the trip's read link", copied.length === 1 && copied[0] === friendsUrl, {
    copied,
    friendsUrl,
  });
  await p.tap(chip("6"));
  await settle(p);
  await p.tap('[data-act="link"]');
  await settle(p, 200);
  const noteLink = await p.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1));
  check("an editor's note link is built on the read link", noteLink === `${friendsUrl}?n=6`, noteLink);
  await p.tap("#s-close");
  await settle(p);
  const before = (await keys(p)).length;

  // Place a note on day 2's track.
  const placing = beside(0.004, 0.0043);
  await p.evaluate(
    (c) =>
      (window as unknown as { trip: { setView(a: number, b: number, z: number): void } }).trip.setView(
        c.lat,
        c.lon,
        14,
      ),
    placing,
  );
  await settle(p);
  await p.tap("#add");
  await settle(p, 200);
  check("＋ starts placing with a banner", await p.$eval("#banner", (e) => e.classList.contains("show")));
  await shot(p, "edit-02-placing");
  const at = await p.evaluate(
    (c) =>
      (window as unknown as { trip: { point(a: number, b: number): { x: number; y: number } } }).trip.point(
        c.lat,
        c.lon,
      ),
    T,
  );
  await p.touchscreen.tap(at.x, at.y);
  await p.waitForFunction(
    () => (window as unknown as { trip: { state(): State } }).trip.state().selected === "13",
    null,
    { timeout: 5000 },
  );
  let s = await state(p);
  check(
    "tapping the map places the next note (13) and opens it",
    s.selected === "13" && (await keys(p)).length === before + 1,
    s,
  );
  const order = await keys(p);
  check(
    "the new note sits on day 2 in the timeline",
    order.indexOf("13") > order.indexOf("d1") && order.indexOf("13") < order.indexOf("d2"),
    order,
  );
  await shot(p, "edit-03-placed");

  await p.tap('[data-act="text"]');
  await p.waitForSelector("#editor.open");
  await p.fill("#e-title", "Testnotiz");
  await p.fill("#e-text", "Self-test **fett**\n\n- eins\n- zwei");
  await shot(p, "edit-04-editor");
  const saveBox = await p.$eval("#e-save", (e) => e.getBoundingClientRect().toJSON());
  check("Sichern sits in thumb reach at the bottom", saveBox.top > 844 / 2, saveBox);
  await p.tap("#e-save");
  await p.waitForSelector("#editor.open", { state: "detached" });
  await settle(p, 500);
  check(
    "saving shows the rendered text and the title",
    (await p.$$(".entry strong")).length === 1 && (await p.textContent("#s-title")) === "Testnotiz",
  );
  check("the chip shows the new title", (await p.textContent(`${chip("13")} .t`)) === "Testnotiz");

  // A draft survives a reload.
  await p.tap('[data-act="text"]');
  await p.waitForSelector("#editor.open");
  await p.fill("#e-text", "Entwurf, nicht gesichert");
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("#add", { state: "attached", timeout: 8000 });
  await settle(p, 600);
  check("a reload reopens the note that was open", (await state(p)).selected === "13");
  await p.tap('[data-act="text"]');
  await p.waitForSelector("#editor.open");
  check("an unsaved draft comes back after a reload", (await p.inputValue("#e-text")) === "Entwurf, nicht gesichert");
  await p.tap("#e-cancel");
  await p.waitForSelector("#editor.open", { state: "detached" });
  check("cancel discards the draft", (await p.textContent(".entry"))?.includes("Self-test") === true);

  // Pick photos from Immich: thumbnails around the note's time, two picked out of order.
  const t13 = Date.parse((await tripView(p)).notes.find((n) => n.key === "13")?.anchor.t as string);
  const near = [-50, -10, 30].map((min, i) => {
    const id = `cafe000${i}-0000-4000-8000-00000000000${i}`;
    stack.immich.assets.set(id, {
      id,
      type: i === 1 ? "VIDEO" : "IMAGE",
      width: 4032,
      height: 3024,
      taken_at: new Date(t13 + min * 60_000).toISOString(),
      colour: ["#b7794f", "#5f7f99", "#7a9e7e"][i],
      duration_ms: 21_000,
    });
    return id;
  });
  check("no file input is left on the page", (await p.$$('input[type="file"]')).length === 0);
  await p.tap('[data-act="photo"]');
  await p.waitForSelector("#picker.open .p-item", { timeout: 8000 });
  await settle(p, 600);
  const grid = await p.$$eval("#p-grid > *", (els) =>
    els.map((e) => (e.classList.contains("p-mark") ? "mark" : (e as HTMLElement).dataset.id)),
  );
  check(
    "Foto opens the picker with the photos around the note's time, the note's time among them",
    near.every((id) => grid.includes(id)) &&
      grid.indexOf(near[0] as string) < grid.indexOf("mark") &&
      grid.indexOf("mark") < grid.indexOf(near[2] as string),
    grid,
  );
  check(
    "the picker is a page of its own: the map and the sheet are hidden",
    await p.evaluate(() => getComputedStyle(document.getElementById("sheet") as HTMLElement).visibility === "hidden"),
  );
  check("a video shows as such in the picker", (await p.textContent(`[data-id="${near[1]}"] .p-vid`)) === "0:21");
  await shot(p, "edit-picker-1-grid");
  await p.tap(`[data-id="${near[2]}"]`);
  await p.tap(`[data-id="${near[0]}"]`);
  await settle(p, 200);
  check("two taps pick two photos", (await p.textContent("#p-add")) === "2 anhängen", await p.textContent("#p-add"));
  const addBox = await p.$eval("#p-add", (e) => e.getBoundingClientRect().toJSON());
  check("the attach button sits in thumb reach at the bottom", addBox.bottom > 844 - 80 && addBox.top > 600, addBox);
  await shot(p, "edit-picker-2-picked");
  await p.tap("#p-add");
  await p.waitForSelector("#picker.open", { state: "detached", timeout: 8000 }).catch(() => {});
  await p.waitForFunction(() => document.querySelectorAll(".media .m").length === 2, null, { timeout: 8000 });
  const ids13 = (await tripView(p)).notes.find((n) => n.key === "13")?.media.map((m) => m.immich_id);
  check(
    "the picked photos are attached in the order they were taken",
    ids13?.join() === [near[0], near[2]].join(),
    ids13,
  );
  await settle(p, 400);
  await shot(p, "edit-picker-3-attached");
  await p.tap('[data-act="photo"]');
  await p.waitForSelector("#picker.open .p-item", { timeout: 8000 });
  check(
    "attached photos are marked and cannot be picked twice",
    await p.$eval(`[data-id="${near[0]}"]`, (b) => (b as HTMLButtonElement).disabled && !!b.querySelector(".p-on")),
  );
  const span0 = await p.textContent("#p-window");
  await p.tap("#p-earlier");
  await p.waitForFunction((w) => document.getElementById("p-window")?.textContent !== w, span0, { timeout: 4000 });
  await p.waitForSelector("#p-grid .p-item, #p-grid .p-empty:not(:has-text('geladen'))", { timeout: 8000 });
  check("früher moves the window", (await p.textContent("#p-window")) !== span0, [
    span0,
    await p.textContent("#p-window"),
  ]);
  await p.goBack();
  await settle(p, 400);
  check(
    "back closes the picker and leaves the note open",
    !(await p.$("#picker.open")) && (await state(p)).selected === "13",
    await state(p),
  );

  // The pasted link stays as a fallback in the picker.
  const pasted = "abcdef01-0000-4000-8000-000000000001";
  stack.immich.assets.set(pasted, {
    id: pasted,
    type: "IMAGE",
    width: 4032,
    height: 3024,
    taken_at: "2026-10-16T09:00:00.000Z",
  });
  await p.tap('[data-act="photo"]');
  await p.waitForSelector("#picker.open form.attach input", { timeout: 4000 });
  await p.fill("form.attach input", "hallo");
  await p.tap("form.attach button");
  await p.waitForSelector("form.attach .err:not(:empty)", { timeout: 4000 });
  check(
    "a text that is no Immich link shows a clear error",
    ((await p.textContent("form.attach .err")) ?? "").includes("kein Immich-Foto-Link"),
  );
  await p.$eval("form.attach", (f) => f.scrollIntoView({ block: "center" }));
  await shot(p, "edit-attach-2-bad-link");
  await p.fill("form.attach input", "https://photos.example.org/photos/abcdef01-0000-4000-8000-0000000000ff");
  await p.tap("form.attach button");
  await p.waitForFunction(
    () => /gibt es in Immich nicht/.test(document.querySelector("form.attach .err")?.textContent ?? ""),
    null,
    {
      timeout: 4000,
    },
  );
  check("a link to a photo Immich does not have shows an error", !!(await p.$("#picker.open")));
  await p.fill(
    "form.attach input",
    `https://photos.example.org/albums/12345678-0000-4000-8000-000000000000/photos/${pasted}?x=1`,
  );
  await p.tap("form.attach button");
  await p.waitForFunction(() => document.querySelectorAll(".media .m").length === 3, null, { timeout: 8000 });
  check("a pasted Immich link attaches the photo", (await p.$$(".media .m")).length === 3);
  check("the picker is gone once the photo is attached", !(await p.$("#picker.open")));
  await settle(p, 500);
  await shot(p, "edit-attach-4-attached");

  // Move it.
  const lat0 = await p.evaluate(async () => {
    const r = await fetch(`/api/t/${location.pathname.slice(1)}`);
    return ((await r.json()) as { notes: { key: string; lat: number }[] }).notes.find((n) => n.key === "13")?.lat;
  });
  await p.tap('[data-act="move"]');
  const movingView = beside(0.009, 0.0043);
  await p.evaluate(
    (c) =>
      (window as unknown as { trip: { setView(a: number, b: number, z: number): void } }).trip.setView(
        c.lat,
        c.lon,
        14,
      ),
    movingView,
  );
  await settle(p, 200);
  const target = beside(0.014, 0.0043);
  const to = await p.evaluate(
    (c) =>
      (window as unknown as { trip: { point(a: number, b: number): { x: number; y: number } } }).trip.point(
        c.lat,
        c.lon,
      ),
    target,
  );
  await shot(p, "edit-05-moving");
  await p.touchscreen.tap(to.x, to.y);
  await p.waitForFunction(
    () => (window as unknown as { trip: { state(): State } }).trip.state().selected === "13",
    null,
    { timeout: 5000 },
  );
  const lat1 = await p.evaluate(async () => {
    const r = await fetch(`/api/t/${location.pathname.slice(1)}`);
    return ((await r.json()) as { notes: { key: string; lat: number }[] }).notes.find((n) => n.key === "13")?.lat;
  });
  check(
    "moving puts the note at the tapped spot",
    lat0 != null && lat1 != null && Math.abs(lat1 - target.lat) < 0.002 && lat1 !== lat0,
    { lat0, lat1 },
  );

  await p.tap('[data-act="delete"]');
  await p.waitForFunction(
    () => !(window as unknown as { trip: { keys(): string[] } }).trip.keys().includes("13"),
    null,
    { timeout: 5000 },
  );
  s = await state(p);
  check("deleting removes the note and closes the sheet", s.selected === null && (await keys(p)).length === before, s);
  // Offline: the placement waits on the device and goes out once the network is back.
  await ctx.setOffline(true);
  await p.tap("#add");
  await settle(p, 200);
  const spot = await p.evaluate(
    (c) =>
      (window as unknown as { trip: { point(a: number, b: number): { x: number; y: number } } }).trip.point(
        c.lat,
        c.lon,
      ),
    target,
  );
  await p.touchscreen.tap(spot.x, spot.y);
  await settle(p, 800);
  const queued = await p.evaluate(
    () => JSON.parse(localStorage.getItem(`trip-outbox:${location.pathname.slice(1)}`) ?? "[]").length,
  );
  check(
    "offline: a placement is kept on the device",
    queued === 1 && (await p.$$(".pin.pending")).length === 1,
    queued,
  );
  await shot(p, "edit-06-offline-pending");
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await p
    .waitForFunction((n) => (window as unknown as { trip: { keys(): string[] } }).trip.keys().length > n, before, {
      timeout: 8000,
    })
    .catch(() => {});
  const after = await p.evaluate(() => ({
    queued: JSON.parse(localStorage.getItem(`trip-outbox:${location.pathname.slice(1)}`) ?? "[]").length,
    pending: document.querySelectorAll(".pin.pending").length,
  }));
  check(
    "back online: the queued placement becomes a note",
    after.queued === 0 && after.pending === 0 && (await keys(p)).length === before + 1,
    { after, n: (await keys(p)).length },
  );

  // An expired login keeps the queue and offers the way back in.
  await ctx.setOffline(true);
  await p.tap("#add");
  await settle(p, 200);
  await p.touchscreen.tap(spot.x, spot.y);
  await settle(p, 800);
  proxy.expire();
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await settle(p, 1200);
  const kept = await p.evaluate(() => ({
    queued: JSON.parse(localStorage.getItem(`trip-outbox:${location.pathname.slice(1)}`) ?? "[]").length,
    badge: document.getElementById("edit-badge")?.textContent,
  }));
  check(
    "an expired login keeps the queued placement and offers to log in",
    kept.queued === 1 && kept.badge === "Anmelden",
    kept,
  );
  proxy.renew();
  await open(p, url);
  await p
    .waitForFunction(() => !localStorage.getItem(`trip-outbox:${location.pathname.slice(1)}`), null, { timeout: 8000 })
    .catch(() => {});
  check(
    "after logging in again the queued placement goes out",
    await p.evaluate(() => !localStorage.getItem(`trip-outbox:${location.pathname.slice(1)}`)),
  );

  // A note without a place: made from the placing banner, placed in the strip by a picked time.
  await settle(p, 400);
  const known = await keys(p);
  await p.tap("#add");
  await p.waitForSelector('#banner [data-b="none"]', { timeout: 4000 });
  await shot(p, "edit-07-placing-banner");
  await p.tap('#banner [data-b="none"]');
  await p.waitForFunction(
    (k) => {
      const s = (window as unknown as { trip: { state(): State } }).trip.state().selected;
      return s != null && !k.includes(s);
    },
    known,
    { timeout: 5000 },
  );
  const k = (await state(p)).selected as string;
  check(
    "Ohne Ort makes a note with no pin, marked in the strip and the sheet",
    !(await p.$(`[data-pin="${k}"]`)) &&
      !!(await p.$(`${chip(k)} .nopin`)) &&
      ((await p.textContent(".meta")) ?? "").includes("ohne Ort") &&
      ((await p.textContent('[data-act="move"]')) ?? "").includes("Ort setzen"),
    k,
  );
  await settle(p, 400);
  await shot(p, "edit-08-no-place");
  const v = await tripView(p);
  const t3 = Date.parse(v.notes.find((n) => n.key === "3")?.anchor.t as string);
  const t7 = Date.parse(v.notes.find((n) => n.key === "7")?.anchor.t as string);
  const mid = Math.round((t3 + t7) / 2 / 60_000) * 60_000;
  await p.tap(".meta .when");
  await p.waitForSelector("form.when-form input", { timeout: 4000 });
  await p.fill("form.when-form input", isoInZone(mid, v.trip.timezone).slice(0, 16));
  await shot(p, "edit-09-time");
  await p.tap('form.when-form button[type="submit"]');
  const between = async () => {
    const o = await keys(p);
    return o.indexOf("3") < o.indexOf(k) && o.indexOf(k) < o.indexOf("7");
  };
  await p
    .waitForFunction(
      (key) => {
        const o = (window as unknown as { trip: { keys(): string[] } }).trip.keys();
        return o.indexOf("3") < o.indexOf(key) && o.indexOf(key) < o.indexOf("7");
      },
      k,
      { timeout: 5000 },
    )
    .catch(() => {});
  const kAt = (await tripView(p)).notes.find((n) => n.key === k)?.anchor.t;
  check(
    "the picked time puts it between the notes around that time",
    (await between()) && Date.parse(kAt ?? "") === mid,
    {
      at: kAt,
      order: await keys(p),
    },
  );
  await settle(p, 400);
  await shot(p, "edit-10-timed");
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("#add", { state: "attached", timeout: 8000 });
  await settle(p, 600);
  check("it is still there after a reload", (await between()) && !(await p.$(`[data-pin="${k}"]`)));
  if ((await state(p)).selected !== k) await p.tap(chip(k));
  await settle(p);
  await p.tap('[data-act="move"]');
  await settle(p, 200);
  check("placing a note without a place offers no Ohne Ort", !(await p.$('#banner [data-b="none"]')));
  const spot2 = await p.evaluate(
    (c) =>
      (window as unknown as { trip: { point(a: number, b: number): { x: number; y: number } } }).trip.point(
        c.lat,
        c.lon,
      ),
    placing,
  );
  await p.touchscreen.tap(spot2.x, spot2.y);
  await p.waitForSelector(`[data-pin="${k}"]`, { timeout: 5000 }).catch(() => {});
  check("Ort setzen gives it a pin, and it keeps its time", !!(await p.$(`[data-pin="${k}"]`)) && (await between()));
  await settle(p, 400);
  await p.tap('[data-act="move"]');
  await p.tap('#banner [data-b="none"]');
  await p.waitForSelector(`[data-pin="${k}"]`, { state: "detached", timeout: 5000 }).catch(() => {});
  check(
    "Ohne Ort while moving takes the pin away, its place in the strip stays",
    !(await p.$(`[data-pin="${k}"]`)) && (await between()),
  );

  await p.tap("#s-close");
  await settle(p);

  // The proxy owns the sign-out page; the stack has none, so the request is answered here.
  await ctx.route(`${stack.editBase}/oauth2/sign_out`, (route) => route.fulfill({ status: 200, body: "signed out" }));
  await p.tap("#edit-badge");
  await p.tap("#edit-stop");
  await p.waitForURL("**/oauth2/sign_out", { timeout: 5000 }).catch(() => {});
  check("logging out goes to the proxy's sign-out", p.url().endsWith("/oauth2/sign_out"), p.url());
  const public_ = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const q = await public_.newPage();
  await open(q, `${stack.base}/${stack.editorView}`);
  await settle(q, 800);
  check("the same trip on the public origin is read-only", (await q.$("#add")) === null);
  const old = await q.request.fetch(`${stack.base}/`, { maxRedirects: 0 });
  check(
    "…and / there sends the visitor to the editing host",
    old.status() === 302 && old.headers().location === `${stack.editBase}/`,
    old.headers().location,
  );
  await public_.close();
  check("edit: no page errors", errors.length === 0, errors);
  await ctx.close();
}

async function homePage(browser: Browser, stack: Stack, tripPath: string) {
  const anon = await browser.newContext();
  const r = await anon.request.fetch(`${stack.base}/`, { maxRedirects: 0 });
  check(
    "on the public origin / shows no trip names",
    r.status() === 302 && !(await r.text()).includes("Mittelgebirge"),
    r.status(),
  );
  await anon.close();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await playProxy(ctx, stack.editBase);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await p.goto(`${stack.editBase}/`, { waitUntil: "domcontentloaded" });
  await shot(p, "home-01-trips");
  const links = await p.$$eval("main a", (a) => a.map((x) => `${x.getAttribute("href")} ${x.textContent}`));
  check("logged in, / lists the trips", links.length >= 1 && links.some((l) => l.includes("Mittelgebirge")), links);
  await p.tap("main a");
  await p.waitForSelector("#add", { timeout: 8000 });
  check(
    "a tap opens the trip in edit mode",
    new URL(p.url()).pathname === tripPath && (await p.isVisible("#edit-badge")),
    p.url(),
  );
  check("home: no page errors", errors.length === 0, errors);
  await ctx.close();
}

async function desktop(browser: Browser, url: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MEDIA_STUB);
  const p = await ctx.newPage();
  const errors: string[] = [];
  await watch(p, errors);
  await open(p, url);
  await settle(p, 500);
  await shot(p, "desktop-01-overview");
  const n = await p.$$eval("#strip .chip", (els) => els.filter((e) => e.getBoundingClientRect().right <= 1440).length);
  check("desktop strip shows six chips or more", n >= 6, n);
  await p.click(chip("6"));
  await settle(p);
  const panel = await p.$eval("#sheet", (e) => e.getBoundingClientRect().toJSON());
  check(
    "desktop: the note opens as a panel on the right",
    panel.left > 900 && panel.top > 80 && panel.height > 600,
    panel,
  );
  check("desktop: the pin is left of the panel", (await pinInBand(p, "6")).ok, await pinInBand(p, "6"));
  await shot(p, "desktop-02-note");
  const order = await keys(p);
  await p.keyboard.press("ArrowRight");
  await settle(p);
  check("desktop: → steps to the next note", (await state(p)).selected === order[order.indexOf("6") + 1]);
  await p.keyboard.press("Escape");
  await settle(p);
  check("desktop: Esc closes", (await state(p)).selected === null);
  await p.click(chip("d3"));
  await settle(p);
  await shot(p, "desktop-03-day-end");
  await p.click(chip("5"));
  await settle(p);
  check(
    "desktop: the note's video plays inline in the panel while the map still pans",
    (await tilePlaying(p, 0)) && (await p.$(".pswp--open")) === null,
  );
  await shot(p, "desktop-03b-video-inline");
  const before = (await state(p)).center;
  await p.mouse.move(400, 500);
  await p.mouse.down();
  await p.mouse.move(300, 450, { steps: 6 });
  await p.mouse.up();
  const after = (await state(p)).center;
  check(
    "desktop: dragging the map moves it and the video keeps playing",
    before.lat !== after.lat && (await tilePlaying(p, 0)),
    { before, after },
  );
  await p.click('.media .m[data-i="1"]');
  await p.waitForSelector(".pswp--open");
  await p.waitForTimeout(600);
  await shot(p, "desktop-04-viewer");
  await p.keyboard.press("Escape");
  check("desktop: no page errors", errors.length === 0, errors);
  await ctx.close();
}

const stack = await startStack();
await stack.call("/api/admin/trips/sample", {
  method: "PATCH",
  admin: true,
  json: { title: "Beispielwanderung Mittelgebirge @Anna", short_title: "Mittelgebirge @Anna" },
});
await stack.call("/api/admin/trips/sample/notes", {
  method: "POST",
  admin: true,
  json: {
    lat: 49.9,
    lon: 7.6,
    number: 12,
    title: "Markup",
    text: '<style>body{outline:12px solid red}</style><div id="toast" style="color:red" name="x">Harmlos</div><form><input><button>Go</button></form>',
  },
});
const browser = await chromium.launch({ executablePath: chromiumPath() });
const read = `${stack.base}/${stack.view}`;
try {
  await phoneReadOnly(browser, read);
  await homePage(browser, stack, `/${stack.view}`);
  await phoneEdit(browser, stack, `${stack.editBase}/${stack.editorView}`, `${stack.base}/${stack.view}`);
  await desktop(browser, read);
} catch (e) {
  check("the run finished", false, (e as Error).message);
} finally {
  await browser.close();
  stack.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
