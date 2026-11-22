#!/usr/bin/env bun
// Captures the README's pictures from the app running on the invented sample data (e2e/stack.ts).
// Needs the built client and a Chromium (see e2e/browsers.ts), and the network for the map tiles:
//   bun run build && bun scripts/screenshots/capture.ts
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "../../e2e/browsers";
import { startStack } from "../../e2e/stack";

const OUT = join(import.meta.dir, "../../docs/images");
const stack = await startStack();
const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${stack.base}/${stack.view}`);
  await page.waitForTimeout(1500);
  await page
    .locator("#strip button, #strip .chip, #strip [data-key]")
    .nth(2)
    .click({ timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT, "trip-desktop.png") });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await phone.newPage();
  await p.goto(`${stack.base}/${stack.view}`);
  await p.waitForTimeout(5000);
  await p.screenshot({ path: join(OUT, "trip-phone.png") });
} finally {
  await browser.close();
  stack.stop();
}
