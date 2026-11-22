// Where the browser tests find their browsers.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** CHROMIUM_PATH, else the newest Playwright headless shell under ~/.cache/ms-playwright. */
export function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), ".cache/ms-playwright");
  const shell = readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .at(-1);
  if (!shell) throw new Error("no Chromium found; set CHROMIUM_PATH");
  return join(cache, shell, "chrome-headless-shell-linux64/chrome-headless-shell");
}

/** WEBKIT_PATH, else Playwright's own WebKit (`playwright-core install webkit`). */
export const webkitPath = (): string | undefined => process.env.WEBKIT_PATH;

/** Chromium flags for WebGL in software, which the map page needs: the headless shell has no GPU. */
export const webglArgs = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];
