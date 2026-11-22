// Builds the client into dist/: hashed bundles under dist/assets/, and dist/index.html and
// dist/map.html with their tags and the placeholders the server fills. The map page has its own
// bundle, so the trip page does not carry MapLibre; MapLibre's module worker is copied as it is and
// its version in the URL keeps the immutable cache honest.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

async function page(entry: string, template: string, target: string) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: join(out, "assets"),
    naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    target: "browser",
    minify: true,
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const tags: string[] = [];
  for (const o of result.outputs) {
    const name = basename(o.path);
    if (o.kind === "entry-point") tags.push(`<script type="module" src="/assets/${name}"></script>`);
    else if (name.endsWith(".css")) tags.unshift(`<link rel="stylesheet" href="/assets/${name}">`);
  }
  const html = readFileSync(join(root, template), "utf8").replace("<!--ASSETS-->", tags.join("\n"));
  writeFileSync(join(out, target), html);
  console.log(result.outputs.map((o) => `${basename(o.path)} ${(o.size / 1024).toFixed(0)} KB`).join("\n"));
}

await page("web/main.ts", "web/index.html", "index.html");
await page("web/map/main.ts", "web/map.html", "map.html");
cpSync(join(root, "web/static"), join(out, "assets"), { recursive: true });
cpSync(join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), join(out, "assets/maplibre-gl-worker.mjs"));
