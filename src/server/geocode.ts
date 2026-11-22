// Address search through a Photon server: visitors' addresses and IPs stop here, answers are cached,
// and each map token has a budget of upstream requests.
import type { GeoHit } from "../shared/api";
import { googleMapsUrl } from "../shared/maplinks";
import { Budget } from "./budget";

const CACHE_SIZE = 1000;
const CACHE_MS = 86_400_000;
const SEARCH_LIMIT = 6;
const HOME_COUNTRY = "Deutschland";

export class GeocodeError extends Error {
  constructor(readonly status: 429 | 502) {
    super(status === 429 ? "zu viele Adresssuchen, bitte kurz warten" : "Adresssuche nicht erreichbar");
  }
}

export interface GeocoderOptions {
  url: string;
  timeoutMs: number;
  retryMs: number;
  perMinute: number;
  userAgent: string;
  now?: () => number;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}

function hit(f: PhotonFeature): GeoHit | null {
  const c = f.geometry?.coordinates;
  const p = f.properties ?? {};
  const lon = Number(c?.[0]);
  const lat = Number(c?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const street = p.street ?? null;
  const housenumber = p.housenumber ?? null;
  const city = p.city ?? null;
  const postcode = p.postcode ?? null;
  const country = p.country ?? null;
  const first = street ? [street, housenumber].filter(Boolean).join(" ") : (p.name ?? null);
  const second = [postcode, city ?? (first === p.name ? null : p.name)].filter(Boolean).join(" ");
  const parts = [first, second, country !== HOME_COUNTRY ? country : null].filter(Boolean);
  if (!parts.length) return null;
  return {
    label: parts.join(", "),
    street,
    housenumber,
    postcode,
    city,
    country,
    lat,
    lon,
    google_url: googleMapsUrl(lat, lon),
  };
}

export class Geocoder {
  private cache = new Map<string, { at: number; hits: GeoHit[] }>();
  private budget: Budget;
  private now: () => number;

  constructor(private opts: GeocoderOptions) {
    this.now = opts.now ?? Date.now;
    this.budget = new Budget(opts.perMinute, this.now);
  }

  search(budget: string, q: string, near?: { lat: number; lon: number }): Promise<GeoHit[]> {
    const params = new URLSearchParams({ q, lang: "de", limit: String(SEARCH_LIMIT) });
    if (near) {
      params.set("lat", String(near.lat));
      params.set("lon", String(near.lon));
    }
    return this.ask(budget, `/api/?${params}`);
  }

  reverse(budget: string, lat: number, lon: number): Promise<GeoHit[]> {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), lang: "de", limit: "1" });
    return this.ask(budget, `/reverse?${params}`);
  }

  private async fetchHits(path: string): Promise<GeoHit[]> {
    const res = await fetch(this.opts.url + path, {
      headers: { "user-agent": this.opts.userAgent },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { features?: PhotonFeature[] };
    const seen = new Set<string>();
    return (body.features ?? []).flatMap((f) => {
      const h = hit(f);
      if (!h || seen.has(h.label)) return [];
      seen.add(h.label);
      return [h];
    });
  }

  private async ask(budget: string, path: string): Promise<GeoHit[]> {
    const cached = this.cache.get(path);
    if (cached && this.now() - cached.at < CACHE_MS) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached.hits;
    }
    if (!this.budget.take(budget)) throw new GeocodeError(429);
    const hits = await this.fetchHits(path).catch(async () => {
      await Bun.sleep(this.opts.retryMs);
      return this.fetchHits(path).catch(() => {
        throw new GeocodeError(502);
      });
    });
    this.cache.delete(path);
    this.cache.set(path, { at: this.now(), hits });
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return hits;
  }
}
