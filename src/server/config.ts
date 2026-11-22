// Loads config/config.yaml, the optional override file, ${VAR} placeholders and TRIP_* overrides,
// and validates the result. See config/config.yaml for the values and the loading order.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  server: { port: number; public_url: string; edit_url: string; max_body_bytes: number };
  data: { dir: string };
  web: { dir: string };
  admin: { token: string };
  immich: {
    url: string;
    api_key: string;
    timeout_ms: number;
    body_timeout_ms: number;
    preview_size: number;
    sweep_minutes: number;
  };
  auth: { editor_from_header: boolean; identity_header: string; sign_out_path: string; allowed_emails: string };
  maps: {
    enabled: boolean;
    geocoder_url: string;
    geocoder_timeout_ms: number;
    geocoder_retry_ms: number;
    geocode_per_minute: number;
    writes_per_minute: number;
    trash_days: number;
    history_keep: number;
    avatar_per_minute: number;
  };
  meet: {
    enabled: boolean;
    car_url: string;
    car_interval_ms: number;
    train_url: string;
    train_interval_ms: number;
    timeout_ms: number;
    cache_days: number;
    cache_none_days: number;
    max_members: number;
    station_radius_km: number;
    train_candidates: number;
    departure_weekday: number;
    departure_hour: number;
  };
  limits: { max_notes: number; max_entries: number; avatar_bytes: number; avatar_px: number };
}

type Kind = "string" | "int" | "url" | "bool";
const SCHEMA: { [S in keyof Config]: { [K in keyof Config[S]]: Kind } } = {
  server: { port: "int", public_url: "url", edit_url: "url", max_body_bytes: "int" },
  data: { dir: "string" },
  web: { dir: "string" },
  admin: { token: "string" },
  immich: {
    url: "url",
    api_key: "string",
    timeout_ms: "int",
    body_timeout_ms: "int",
    preview_size: "int",
    sweep_minutes: "int",
  },
  auth: { editor_from_header: "bool", identity_header: "string", sign_out_path: "string", allowed_emails: "string" },
  maps: {
    enabled: "bool",
    geocoder_url: "url",
    geocoder_timeout_ms: "int",
    geocoder_retry_ms: "int",
    geocode_per_minute: "int",
    writes_per_minute: "int",
    trash_days: "int",
    history_keep: "int",
    avatar_per_minute: "int",
  },
  meet: {
    enabled: "bool",
    car_url: "url",
    car_interval_ms: "int",
    train_url: "url",
    train_interval_ms: "int",
    timeout_ms: "int",
    cache_days: "int",
    cache_none_days: "int",
    max_members: "int",
    station_radius_km: "int",
    train_candidates: "int",
    departure_weekday: "int",
    departure_hour: "int",
  },
  limits: { max_notes: "int", max_entries: "int", avatar_bytes: "int", avatar_px: "int" },
};

type Tree = Record<string, Record<string, unknown>>;

function merge(base: Tree, over: Tree): Tree {
  const out: Tree = structuredClone(base);
  for (const [s, values] of Object.entries(over ?? {})) out[s] = { ...(out[s] ?? {}), ...values };
  return out;
}

function resolve(value: unknown, env: Record<string, string | undefined>, where: string): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (!v) throw new Error(`config ${where}: environment variable ${name} is not set`);
    return v;
  });
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  root = join(import.meta.dir, "../.."),
): Config {
  let tree = Bun.YAML.parse(readFileSync(join(root, "config/config.yaml"), "utf8")) as Tree;
  const override = env.TRIP_CONFIG_OVERRIDE;
  if (override) {
    const path = override.startsWith("/") ? override : join(root, override);
    if (existsSync(path)) tree = merge(tree, (Bun.YAML.parse(readFileSync(path, "utf8")) as Tree) ?? {});
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [section, keys] of Object.entries(SCHEMA)) {
    out[section] = {};
    for (const [key, kind] of Object.entries(keys as Record<string, Kind>)) {
      const where = `${section}.${key}`;
      const fromEnv = env[`TRIP_${section}_${key}`.toUpperCase()];
      let v = fromEnv ?? resolve(tree[section]?.[key], env, where);
      if (v === undefined || v === null || v === "") throw new Error(`config ${where} is missing`);
      if (kind === "bool") {
        if (v !== true && v !== false && v !== "true" && v !== "false")
          throw new Error(`config ${where} must be true or false`);
        v = v === true || v === "true";
      } else if (kind === "int") {
        v = Number(v);
        if (!Number.isInteger(v)) throw new Error(`config ${where} must be an integer`);
      } else {
        v = String(v);
        if (kind === "url" && !/^https?:\/\/[^/]+(\/.*[^/])?$/.test(v as string))
          throw new Error(`config ${where} must be an http(s) URL without a trailing slash`);
      }
      out[section][key] = v;
    }
  }
  const config = out as unknown as Config;
  checkConfig(config);
  return config;
}

/** A host under a reserved example domain: what config.yaml ships as a placeholder. */
export const isPlaceholderUrl = (url: string) => /(^|\.)example\.(org|com|net)$/.test(new URL(url).hostname);

function checkConfig(c: Config): void {
  const placeholders: [string, string][] = [
    ["server.public_url", c.server.public_url],
    ["immich.url", c.immich.url],
  ];
  if (c.auth.editor_from_header) placeholders.push(["server.edit_url", c.server.edit_url]);
  for (const [where, url] of placeholders)
    if (isPlaceholderUrl(url))
      throw new Error(`config ${where} still holds the placeholder ${url}; set it to your own URL`);
  if (c.meet.enabled && !c.maps.enabled) throw new Error("config meet.enabled needs maps.enabled");
  if (!c.auth.sign_out_path.startsWith("/")) throw new Error("config auth.sign_out_path must start with /");
}
