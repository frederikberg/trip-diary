// The map API for the page's own token.
import type {
  ApiError,
  Entry,
  EntryCreate,
  EntryPatch,
  EntryRestore,
  EntryWritten,
  GeoHit,
  MapView,
  MeetMemberPut,
  MeetState,
} from "../../src/shared/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

const SEARCH_RETRY_MS = 1500;

const MESSAGES: Record<number, string> = {
  400: "Das ging nicht: eine Angabe passt nicht.",
  413: "Das Bild ist zu groß.",
  415: "Dieses Bildformat geht nicht.",
  403: "Mit diesem Link lässt sich nur ansehen.",
  404: "Diesen Eintrag gibt es nicht mehr.",
  409: "Die Karte ist voll.",
  429: "Gerade zu viele Änderungen, bitte kurz warten.",
};

/** What the user reads about a failed request. */
export function failureText(e: unknown): string {
  if (e instanceof ApiFailure) return MESSAGES[e.status] ?? "Das ging gerade nicht, bitte nochmal.";
  return "Kein Netz – bitte später nochmal.";
}

export class MapApi {
  private readonly base: string;
  private etag: string | null = null;

  constructor(token: string) {
    this.base = `/api/m/${token}`;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    const res = await fetch(this.base + path, { ...init, headers });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
    return body as T;
  }

  /** The map, or null when it did not change since the last call. */
  async view(): Promise<MapView | null> {
    const headers = new Headers();
    if (this.etag) headers.set("if-none-match", this.etag);
    const res = await fetch(this.base, { headers, cache: "no-cache" });
    if (res.status === 304) return null;
    if (!res.ok) throw new ApiFailure(res.status, await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
    this.etag = res.headers.get("etag");
    return (await res.json()) as MapView;
  }

  create(body: EntryCreate): Promise<Entry> {
    return this.req("/entries", { method: "POST", body: JSON.stringify(body) });
  }

  get(id: number): Promise<Entry> {
    return this.req(`/entries/${id}`);
  }

  patch(id: number, body: EntryPatch): Promise<EntryWritten> {
    return this.req(`/entries/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  remove(id: number, by: string | null): Promise<EntryWritten> {
    return this.req(`/entries/${id}${by ? `?by=${encodeURIComponent(by)}` : ""}`, { method: "DELETE" });
  }

  async purge(id: number): Promise<void> {
    await this.req(`/entries/${id}/purge`, { method: "DELETE" });
  }

  restore(id: number, body: EntryRestore): Promise<Entry> {
    return this.req(`/entries/${id}/restore`, { method: "POST", body: JSON.stringify(body) });
  }

  /** A failed search is asked once more before it counts: the geocoder drops single requests. */
  async search(q: string, near: { lat: number; lon: number } | null, signal?: AbortSignal): Promise<GeoHit[]> {
    const params = new URLSearchParams({ q });
    if (near) {
      params.set("lat", String(near.lat));
      params.set("lon", String(near.lon));
    }
    try {
      return await this.req(`/geocode?${params}`, { signal });
    } catch (e) {
      if (signal?.aborted || (e instanceof ApiFailure && e.status < 500)) throw e;
      await new Promise((done) => setTimeout(done, SEARCH_RETRY_MS));
      return this.req(`/geocode?${params}`, { signal });
    }
  }

  meet(): Promise<MeetState> {
    return this.req("/meet");
  }

  putMember(entry: number, body: MeetMemberPut): Promise<MeetState> {
    return this.req(`/meet/members/${entry}`, { method: "PUT", body: JSON.stringify(body) });
  }

  deleteMember(entry: number): Promise<MeetState> {
    return this.req(`/meet/members/${entry}`, { method: "DELETE" });
  }

  compute(): Promise<MeetState> {
    return this.req("/meet/compute", { method: "POST" });
  }

  putAvatar(id: number, picture: Blob, by: string | null): Promise<EntryWritten> {
    const q = by ? `?by=${encodeURIComponent(by)}` : "";
    return this.req(`/entries/${id}/avatar${q}`, {
      method: "PUT",
      body: picture,
      headers: { "content-type": picture.type },
    });
  }

  deleteAvatar(id: number, by: string | null): Promise<EntryWritten> {
    return this.req(`/entries/${id}/avatar${by ? `?by=${encodeURIComponent(by)}` : ""}`, { method: "DELETE" });
  }

  reverse(lat: number, lon: number): Promise<GeoHit[]> {
    return this.req(`/geocode?lat=${lat}&lon=${lon}`);
  }
}
