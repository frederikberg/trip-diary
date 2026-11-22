// Entry point: config, database, the built client, the HTTP server.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDb, Store } from "./db";
import { Geocoder } from "./geocode";
import { Immich } from "./immich";
import { purgeEntries } from "./maps";
import { sweepMedia } from "./sweep";
import { createTravel } from "./travel";

const config = loadConfig();
mkdirSync(config.data.dir, { recursive: true });
const store = new Store(openDb(join(config.data.dir, "trip.db")));
const immich = new Immich(config.immich.url, config.immich.api_key, {
  timeoutMs: config.immich.timeout_ms,
  bodyTimeoutMs: config.immich.body_timeout_ms,
  previewSize: config.immich.preview_size,
});
const geocoder = new Geocoder({
  url: config.maps.geocoder_url,
  timeoutMs: config.maps.geocoder_timeout_ms,
  retryMs: config.maps.geocoder_retry_ms,
  perMinute: config.maps.geocode_per_minute,
  userAgent: `trip-diary/${pkg.version} (+${config.server.public_url})`,
});
const built = (name: string) => {
  const path = join(config.web.dir, name);
  if (existsSync(path)) return readFileSync(path, "utf8");
  console.warn(`no client at ${path}; its pages answer 503`);
  return null;
};

const server = Bun.serve({
  port: config.server.port,
  maxRequestBodySize: config.server.max_body_bytes,
  fetch: createApp({
    config,
    store,
    immich,
    geocoder,
    travel: createTravel(config, store, `trip-diary/${pkg.version} (+${config.server.public_url})`),
    html: built("index.html"),
    mapHtml: built("map.html"),
    version: pkg.version,
  }),
});
console.log(`trip-diary ${pkg.version} listening on :${server.port}`);

const sweep = () =>
  sweepMedia(store, immich, () => new Date())
    .then((n) => n && console.log(`media sweep: ${n} changed availability`))
    .catch((e) => console.error("media sweep failed:", e));
setTimeout(sweep, 30_000);
setInterval(sweep, config.immich.sweep_minutes * 60_000);

if (config.maps.enabled) {
  const purge = () => {
    const n = purgeEntries(store, config.maps.trash_days, new Date());
    if (n) console.log(`map trash: ${n} entries removed for good`);
    store.purgeAvatars();
  };
  purge();
  setInterval(purge, 3_600_000);
}

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    server.stop();
    store.db.close();
    process.exit(0);
  });
