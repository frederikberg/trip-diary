#!/usr/bin/env bun
// Types into the note editor on an iPhone-sized page in WebKit and Chromium while the visual viewport
// reports what iOS reports around its on-screen keyboard, and checks that text, caret and the editor
// stay put; a draft from an earlier client version opens; screenshots at 390×844 and 1440×900:
//   bun run build && bun e2e/typing.ts [out-dir]
// Browsers: see e2e/browsers.ts.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserType, chromium, devices, type Page, webkit } from "playwright-core";
import { chromiumPath, webkitPath } from "./browsers";
import { playProxy, type Stack, startStack } from "./stack";

const out = process.argv[2] ?? join(homedir(), ".tmp", "trip-diary-typing");
await mkdir(out, { recursive: true });

const results: { ok: boolean; name: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  results.push({ ok, name });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const phone = devices["iPhone 15 Pro"];

interface Field {
  value: string;
  start: number;
  end: number;
  /** The text field's top in document coordinates: moved only by layout, never by scrolling. */
  docTop: number;
}
const field = (p: Page): Promise<Field> =>
  p.$eval("#e-text", (e) => {
    const t = e as HTMLTextAreaElement;
    return {
      value: t.value,
      start: t.selectionStart,
      end: t.selectionEnd,
      docTop: Math.round(t.getBoundingClientRect().top + scrollY),
    };
  });

/** Makes `visualViewport` report a keyboard-sized height and a pan offset, and fires its events, as iOS does. */
const viewport = (p: Page, offsetTop: number, height: number) =>
  p.evaluate(
    ([top, h]) => {
      const vv = window.visualViewport;
      if (!vv) return;
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => top });
      Object.defineProperty(vv, "height", { configurable: true, get: () => h });
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
    [offsetTop, height],
  );

/** Whether the editor is what shows at the left edge, top, middle and bottom of the layout viewport. */
const covers = (p: Page) =>
  p.evaluate(() =>
    [4, innerHeight / 2, innerHeight - 4].every((y) => document.elementFromPoint(4, y)?.closest("#editor") != null),
  );

/** Everything the page does on its own between keystrokes: the refresh on becoming visible, and a pause. */
async function idle(p: Page, ms: number) {
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(ms);
}

async function openEditor(p: Page, stack: Stack, key: string) {
  await p.goto(`${stack.editBase}/${stack.editorView}?n=${key}`);
  await p.waitForSelector('[data-act="text"]', { timeout: 8000 });
  await p.click('[data-act="text"]');
  await p.waitForSelector("#editor.open");
}

async function typing(engine: string, browser: Browser, stack: Stack) {
  const ctx = await browser.newContext({ ...phone, ignoreHTTPSErrors: true });
  await playProxy(ctx, stack.editBase);
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await openEditor(p, stack, "1");
  const H = phone.viewport.height;
  check(`${engine}: the editor covers the page`, await covers(p));

  // Long text, typed at the end in batches, with the keyboard opening and the viewport panning between them.
  await p.$eval("#e-text", (e) => {
    const t = e as HTMLTextAreaElement;
    t.value = "";
    t.dispatchEvent(new Event("input"));
  });
  await p.focus("#e-text");
  let expected = "";
  const lines = Array.from(
    { length: 14 },
    (_, i) => `Zeile ${i + 1}: Wir gingen heute lange durch den Wald und sahen fast niemanden.`,
  );
  const steps: [string, number, number][] = [
    ["the keyboard opens", 0, Math.round(H * 0.55)],
    ["the viewport pans to the caret", 160, Math.round(H * 0.55)],
    ["the viewport pans further", 320, Math.round(H * 0.55)],
    ["the keyboard closes with a stale offset", 320, H],
  ];
  for (const [i, [what, top, height]] of steps.entries()) {
    const batch = `${lines.slice(i * 3, i * 3 + 3).join("\n")}\n`;
    await p.keyboard.type(batch);
    expected += batch;
    const before = await field(p);
    await viewport(p, top, height);
    await idle(p, 600);
    const after = await field(p);
    check(
      `${engine}: at the end, ${what}: text and caret are where typing left them`,
      after.value === expected && after.start === expected.length && after.end === expected.length,
      { start: after.start, end: after.end, want: expected.length, same: after.value === expected },
    );
    check(`${engine}: at the end, ${what}: the text field does not move`, after.docTop === before.docTop, {
      before: before.docTop,
      after: after.docTop,
    });
  }
  check(`${engine}: with the keyboard gone the editor still covers the page`, await covers(p));
  await p.screenshot({ path: join(out, `editor-${engine}-long.jpg`), type: "jpeg", quality: 70, fullPage: true });

  // In the middle: inside the first line's "gingen".
  const at = expected.indexOf("gingen") + 3;
  await p.$eval("#e-text", (e, n) => (e as HTMLTextAreaElement).setSelectionRange(n, n), at);
  await p.keyboard.type("XYZ");
  expected = `${expected.slice(0, at)}XYZ${expected.slice(at)}`;
  await viewport(p, 200, Math.round(H * 0.55));
  await idle(p, 2500);
  await p.keyboard.type(" und weiter");
  expected = `${expected.slice(0, at + 3)} und weiter${expected.slice(at + 3)}`;
  const mid = await field(p);
  check(
    `${engine}: in the middle, across a pause: text and caret are where typing left them`,
    mid.value === expected && mid.start === at + 3 + " und weiter".length && mid.end === mid.start,
    { start: mid.start, want: at + 3 + " und weiter".length, same: mid.value === expected },
  );

  // Back to the end after a pause, then save.
  await p.$eval("#e-text", (e) => {
    const t = e as HTMLTextAreaElement;
    t.setSelectionRange(t.value.length, t.value.length);
  });
  await idle(p, 1500);
  await p.keyboard.type("Ende.");
  expected += "Ende.";
  const end = await field(p);
  check(
    `${engine}: at the end again after a pause: text and caret are where typing left them`,
    end.value === expected && end.start === expected.length,
    { start: end.start, want: expected.length },
  );
  await p.click("#e-save");
  await p.waitForSelector("#editor.open", { state: "detached" });
  const saved = await p.evaluate(
    async ([t]) => {
      const r = await fetch(`/api/t/${t}`);
      return ((await r.json()) as { notes: { key: string; text: string }[] }).notes.find((n) => n.key === "1")?.text;
    },
    [stack.editorView],
  );
  check(`${engine}: saving stores exactly what was typed`, saved === expected);
  check(`${engine}: no page errors`, errors.length === 0, errors);
  await ctx.close();
}

/** A draft as earlier client versions kept it: `trip-draft:<view token>:<note key>` → `{title, text}`. */
async function oldDraft(engine: string, browser: Browser, stack: Stack) {
  const ctx = await browser.newContext({ ...phone, ignoreHTTPSErrors: true });
  await playProxy(ctx, stack.editBase);
  const p = await ctx.newPage();
  const draftKey = `trip-draft:${stack.editorView}:2`;
  await p.goto(`${stack.editBase}/${stack.editorView}`);
  await p.evaluate(
    ([k]) =>
      localStorage.setItem(k as string, JSON.stringify({ title: "Entwurfstitel", text: "Text aus dem alten Editor" })),
    [draftKey],
  );
  await openEditor(p, stack, "2");
  check(
    `${engine}: a draft kept by an earlier version opens`,
    (await p.inputValue("#e-title")) === "Entwurfstitel" &&
      (await p.inputValue("#e-text")) === "Text aus dem alten Editor",
  );
  await p.click("#e-save");
  await p.waitForSelector("#editor.open", { state: "detached" });
  check(
    `${engine}: saving it clears the draft`,
    (await p.evaluate(([k]) => localStorage.getItem(k as string), [draftKey])) === null,
  );
  await ctx.close();
}

async function screenshots(browser: Browser, stack: Stack) {
  for (const [name, opts] of [
    ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
    ["desktop", { viewport: { width: 1440, height: 900 } }],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, ignoreHTTPSErrors: true });
    await playProxy(ctx, stack.editBase);
    const p = await ctx.newPage();
    await openEditor(p, stack, "3");
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(out, `editor-${name}.jpg`), type: "jpeg", quality: 70 });
    check(`${name}: the editor covers the page`, await covers(p));
    await ctx.close();
  }
}

const engines: [string, BrowserType, string | undefined][] = [
  ["chromium", chromium, chromiumPath()],
  ["webkit", webkit, webkitPath()],
];
const stack = await startStack(0, { https: true });
try {
  for (const [name, type, executablePath] of engines) {
    let browser: Browser;
    try {
      browser = await type.launch({ executablePath });
    } catch (e) {
      check(`${name} launches (see e2e/browsers.ts)`, false, (e as Error).message.split("\n")[0]);
      continue;
    }
    try {
      await typing(name, browser, stack);
      await oldDraft(name, browser, stack);
      if (name === "chromium") await screenshots(browser, stack);
    } catch (e) {
      check(`${name}: the run finished`, false, (e as Error).message);
    } finally {
      await browser.close();
    }
  }
} finally {
  stack.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
