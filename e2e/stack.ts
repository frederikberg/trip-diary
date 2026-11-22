// The app with the built client on a temporary database, a fake Immich, a fake geocoder, the sample
// trip and the sample map.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import {
  EDITOR_EMAIL,
  type FakeGeocoder,
  type FakeImmich,
  type FakeRouters,
  fakeGeocoder,
  fakeImmich,
  fakeRouters,
  seedTrip,
  type TestApp,
  testApp,
} from "../test/helpers";
import { addSample } from "./sample";
import { addSampleMap, SAMPLE_GEO } from "./sample-map";

export interface Stack {
  /** The public origin: view links and map links. */
  base: string;
  /** The editing origin: the same server under another name, where the proxy's login would stand. */
  editBase: string;
  /** The friends' view token. */
  view: string;
  /** The view token the editor opens (the trip's only link). */
  editorView: string;
  /** The fake Immich behind the app, for adding assets to paste. */
  immich: FakeImmich;
  /** The sample map's read link token. */
  mapView: string;
  /** The sample map's write link token. */
  mapEdit: string;
  /** The fake Photon behind the map's address search. */
  geocoder: FakeGeocoder;
  /** The fake car and train services behind the meeting point. */
  routers: FakeRouters;
  /** The app's request function, for setting up cases through the admin API. */
  call: TestApp["call"];
  stop(): void;
}

/**
 * Plays the reverse proxy's login for a browser context: while on, every request to the editing
 * origin carries the identity header, and no other request does.
 */
export async function playProxy(ctx: BrowserContext, editBase: string) {
  let on = true;
  await ctx.route(
    (url) => url.origin === editBase,
    (route) =>
      route.continue(on ? { headers: { ...route.request().headers(), "x-auth-request-email": EDITOR_EMAIL } } : {}),
  );
  return {
    /** The login ran out: requests carry no identity any more. */
    expire() {
      on = false;
    },
    renew() {
      on = true;
    },
  };
}

/** A throwaway self-signed certificate for localhost and 127.0.0.1, made with the `openssl` binary. */
function selfSigned(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "trip-e2e-tls-"));
  const files = { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
  const r = Bun.spawnSync(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost"].concat([
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      files.key,
      "-out",
      files.cert,
    ]),
    { stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`openssl could not make a certificate: ${r.stderr.toString().trim()}`);
  return { cert: readFileSync(files.cert, "utf8"), key: readFileSync(files.key, "utf8") };
}

/**
 * Starts the app on the sample trip. The public origin is `127.0.0.1`, the editing origin `localhost`.
 * With `https` it serves a self-signed certificate (browsers need `ignoreHTTPSErrors`).
 */
export async function startStack(port = 0, { https = false } = {}): Promise<Stack> {
  const dist = join(import.meta.dir, "../dist");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const mapHtml = readFileSync(join(dist, "map.html"), "utf8");
  const immich = fakeImmich();
  const geocoder = fakeGeocoder(SAMPLE_GEO);
  const routers = fakeRouters();
  // The port is known only once the server runs, and the app's public origin must match it.
  let handle: TestApp["fetch"] = async () => new Response(null, { status: 503 });
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (r) => handle(r),
    maxRequestBodySize: 26214400,
    ...(https ? { tls: selfSigned() } : {}),
  });
  const scheme = https ? "https" : "http";
  const origin = `${scheme}://127.0.0.1:${server.port}`;
  const editBase = `${scheme}://localhost:${server.port}`;
  const app = testApp(immich.url, html, dist, {
    publicUrl: origin,
    editUrl: editBase,
    maps: { geocoder_url: geocoder.url },
    meet: { car_url: routers.carUrl, train_url: routers.trainUrl, train_interval_ms: 30 },
    mapHtml,
  });
  handle = app.fetch;
  const { view } = await seedTrip(app);
  await addSample(app, immich);
  const map = await addSampleMap(app);
  return {
    base: origin,
    editBase,
    view,
    editorView: view,
    immich,
    mapView: map.view,
    mapEdit: map.edit,
    geocoder,
    routers,
    call: app.call,
    stop() {
      server.stop(true);
      immich.stop();
      geocoder.stop();
      routers.stop();
    },
  };
}

if (import.meta.main) {
  const s = await startStack(Number(process.argv[2] ?? 8090));
  console.log(
    `read-only: ${s.base}/${s.view}\nedit:      ${s.editBase}/${s.editorView} (needs the header x-auth-request-email: ${EDITOR_EMAIL})`,
  );
  console.log(`map, read:  ${s.base}/m/${s.mapView}\nmap, write: ${s.base}/m/${s.mapEdit}`);
}
