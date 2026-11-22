#!/usr/bin/env bun
// Writes the map page's pictures into web/static: map-base.jpg, the base map of Central Europe in the
// section `SECTION` fixes (no pins; the server draws the real ones on it), map-fallback.jpg, the same
// section with made-up pins for maps with nothing to show, and map-icon-180.png from map-icon.svg. No
// data of any map goes into them. Run by hand on a built client; the output is committed.
//   bun run build && bun scripts/map-preview.ts
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath, webglArgs } from "../e2e/browsers";
import { startStack } from "../e2e/stack";
import { project, SECTION } from "../src/server/preview";

const SIZE = SECTION.size / SECTION.deviceScale;
// Places the base map has to show, with room for a pin.
const CITIES: [string, number, number][] = [
  ["Köln", 50.94, 6.96],
  ["Freiburg", 47.99, 7.85],
  ["München", 48.14, 11.58],
  ["Kiel", 54.32, 10.14],
  ["Rostock", 54.09, 12.1],
  ["Malmö", 55.6, 13.0],
];
for (const [name, lat, lon] of CITIES) {
  const at = project(lat, lon);
  if (!at || [...at, ...at.map((v) => SECTION.size - v)].some((d) => d < 70))
    throw new Error(`${name} is not in the section`);
}
const PINS: [string, number, number, number][] = [
  ["🏡", 0, 53.1, 8.4],
  ["🌻", 1, 53.0, 12.0],
  ["🚲", 2, 51.3, 5.4],
  ["⛰️", 3, 47.7, 11.2],
  ["☕", 4, 50.4, 10.2],
  ["🦊", 5, 48.3, 9.3],
  ["🌊", 6, 54.3, 11.3],
  ["🐝", 7, 49.3, 13.4],
  ["🎒", 8, 48.9, 16.3],
  ["🌳", 9, 48.4, 5.0],
];

const dir = join(import.meta.dir, "../web/static");
const stack = await startStack(0);
const res = await stack.call("/api/admin/maps", {
  method: "POST",
  admin: true,
  json: { slug: "preview", title: "Vorschau" },
});
const { edit } = (await res.json()) as { edit: { token: string } };

const browser = await chromium.launch({ executablePath: chromiumPath(), args: webglArgs });

async function shoot(file: string): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: SECTION.deviceScale,
  });
  await page.goto(`${stack.base}/m/${edit.token}`);
  await page.addStyleTag({
    content: `#search,#sheet,.fabs,#badge,#toast,.maplibregl-ctrl,.pin .n{display:none!important}
      .pin{transform-origin:bottom;width:48px;height:48px}.pin .f{font-size:26px}`,
  });
  type Hook = { map: { loaded(): boolean; jumpTo(o: unknown): void } };
  await page.waitForFunction(() => (window as unknown as { people?: Hook }).people?.map.loaded());
  await page.evaluate(
    (s) =>
      (window as unknown as { people: Hook }).people.map.jumpTo({ center: [s.lon, s.lat], zoom: s.zoom, duration: 0 }),
    SECTION,
  );
  await page.waitForFunction(() => (window as unknown as { people: Hook }).people.map.loaded());
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(dir, file), type: "jpeg", quality: 82 });
  await page.close();
}

await shoot("map-base.jpg");
for (const [emoji, color, lat, lon] of PINS)
  await stack.call("/api/admin/maps/preview/entries", {
    method: "POST",
    admin: true,
    json: { name: "x", emoji, color, places: [{ label: "", address: "", lat, lon }] },
  });
await shoot("map-fallback.jpg");

const icon = await browser.newPage({ viewport: { width: 90, height: 90 }, deviceScaleFactor: 2 });
const svg = await Bun.file(join(dir, "map-icon.svg")).text();
await icon.setContent(`<body style="margin:0">${svg}</body>`);
await icon.screenshot({ path: join(dir, "map-icon-180.png") });

await browser.close();
stack.stop();
console.log("web/static: map-base.jpg, map-fallback.jpg, map-icon-180.png");
process.exit(0);
