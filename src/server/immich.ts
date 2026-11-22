// The Immich API, as far as the app uses it: asset metadata and search (asset.read), thumbnails,
// previews and video playback (asset.view), and the albums shared with the key's user (album.read,
// optional). The key is sent only from here and never reaches a client.
import { createHash } from "node:crypto";
import type { MediaSize, MediaType } from "../shared/api";

export interface AssetInfo {
  id: string;
  type: MediaType;
  taken_at: string | null;
  lat: number | null;
  lon: number | null;
  /** Preview dimensions, orientation applied. */
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** Changes when Immich regenerates the asset's images. */
  v: string;
}

export class ImmichError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Immich's own status, when it answered. */
    readonly upstream: number | null = null,
  ) {
    super(message);
  }
}

/** A shared album's span: the days of its first and last asset, wall clock, as Immich gives them. */
interface AlbumSpan {
  id: string;
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;

interface RawAsset {
  id: string;
  type: string;
  width?: number | null;
  height?: number | null;
  duration?: number | string | null;
  thumbhash?: string | null;
  updatedAt?: string;
  fileCreatedAt?: string;
  isTrashed?: boolean;
  exifInfo?: {
    latitude?: number | null;
    longitude?: number | null;
    dateTimeOriginal?: string | null;
    exifImageWidth?: number | null;
    exifImageHeight?: number | null;
    orientation?: string | null;
  } | null;
}

/** Immich gives durations in milliseconds; older servers sent `h:mm:ss.fff`. */
function durationMs(d: RawAsset["duration"]): number | null {
  if (typeof d === "number") return d || null;
  if (typeof d !== "string") return null;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d);
  if (!m) return null;
  const ms = Math.round(((+(m[1] as string) * 60 + +(m[2] as string)) * 60 + +(m[3] as string)) * 1000);
  return ms || null;
}

export class Immich {
  private readonly timeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly previewSize: number;
  private readonly albumsMs: number;
  private albums: { at: number; list: AlbumSpan[] } | null = null;
  private albumsFetch: Promise<AlbumSpan[]> | null = null;
  private albumsDenied = false;

  constructor(
    private readonly url: string,
    private readonly key: string,
    o: { timeoutMs: number; bodyTimeoutMs: number; previewSize: number; albumsMs: number },
  ) {
    this.timeoutMs = o.timeoutMs;
    this.bodyTimeoutMs = o.bodyTimeoutMs;
    this.previewSize = o.previewSize;
    this.albumsMs = o.albumsMs;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.key);
    headers.set("accept", "application/json");
    const res = await fetch(this.url + path, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) }).catch(
      (e: Error) => {
        throw new ImmichError(`Immich unreachable: ${e.message}`, 502);
      },
    );
    if (res.status === 400 || res.status === 404) throw new ImmichError("asset not found in Immich", 404, res.status);
    if (!res.ok) throw new ImmichError(`Immich answered ${res.status}`, 502, res.status);
    return res;
  }

  toInfo(a: RawAsset): AssetInfo {
    if (a.type !== "IMAGE" && a.type !== "VIDEO") throw new ImmichError(`unsupported asset type ${a.type}`, 400);
    let { width = null, height = null } = a;
    if (!width || !height) {
      // Assets imported before Immich stored their size carry it only in EXIF, unrotated.
      const e = a.exifInfo;
      const sideways = ["5", "6", "7", "8"].includes(e?.orientation ?? "");
      width = (sideways ? e?.exifImageHeight : e?.exifImageWidth) ?? null;
      height = (sideways ? e?.exifImageWidth : e?.exifImageHeight) ?? null;
    }
    if (width && height) {
      const k = Math.min(1, this.previewSize / Math.max(width, height));
      width = Math.round(width * k);
      height = Math.round(height * k);
    }
    const lat = a.exifInfo?.latitude ?? null;
    const lon = a.exifInfo?.longitude ?? null;
    return {
      id: a.id,
      type: a.type === "VIDEO" ? "video" : "image",
      taken_at: a.exifInfo?.dateTimeOriginal ?? a.fileCreatedAt ?? null,
      lat: lat != null && lon != null ? lat : null,
      lon: lat != null && lon != null ? lon : null,
      width: width || null,
      height: height || null,
      duration_ms: a.type === "VIDEO" ? durationMs(a.duration) : null,
      v: createHash("sha256")
        .update(`${a.thumbhash ?? ""}|${a.updatedAt ?? ""}`)
        .digest("hex")
        .slice(0, 12),
    };
  }

  async asset(id: string): Promise<AssetInfo> {
    const raw = (await (await this.call(`/api/assets/${encodeURIComponent(id)}`)).json()) as RawAsset;
    if (raw.isTrashed) throw new ImmichError("asset is in the Immich trash", 404);
    return this.toInfo(raw);
  }

  /**
   * The albums shared with or by the key's user, kept for `albumsMs`; requests arriving while the
   * list is fetched share that fetch. Without album.read on the key there are none, and a failing
   * fetch gives none this once.
   */
  private sharedAlbums(): Promise<AlbumSpan[]> {
    if (this.albums && Date.now() - this.albums.at < this.albumsMs) return Promise.resolve(this.albums.list);
    this.albumsFetch ??= this.fetchAlbums().finally(() => {
      this.albumsFetch = null;
    });
    return this.albumsFetch;
  }

  private async fetchAlbums(): Promise<AlbumSpan[]> {
    let list: AlbumSpan[] = [];
    try {
      const res = await this.call("/api/albums?isShared=true");
      const raw = (await res.json()) as { id: string; startDate?: string | null; endDate?: string | null }[];
      list = raw.flatMap((a) => {
        const start = Date.parse(a.startDate ?? "");
        const end = Date.parse(a.endDate ?? "");
        return Number.isFinite(start) && Number.isFinite(end) ? [{ id: a.id, start, end }] : [];
      });
      this.albumsDenied = false;
    } catch (e) {
      if (!(e instanceof ImmichError) || e.upstream !== 403) {
        console.warn(`shared albums: ${(e as Error).message}; the photo picker shows the key's own assets only`);
        return [];
      }
      if (!this.albumsDenied)
        console.warn("shared albums: the Immich key lacks album.read; the photo picker shows its own assets only");
      this.albumsDenied = true;
    }
    this.albums = { at: Date.now(), list };
    return list;
  }

  /**
   * Every image and video taken in [from, to), oldest first: the key's own library (with its
   * partners') and what the albums shared with it hold, in one search.
   */
  async search(from: string, to: string): Promise<AssetInfo[]> {
    const lo = Date.parse(from);
    const hi = Date.parse(to);
    // Album days are wall clock: a day either side covers every zone.
    const albumIds = (await this.sharedAlbums())
      .filter((a) => a.start < hi + DAY_MS && a.end + 2 * DAY_MS > lo)
      .map((a) => a.id);
    // Immich's search includes trashed assets unless told otherwise.
    const base = { takenAt: { gte: from, lt: to }, trashedAt: { eq: null } };
    if (albumIds.length)
      try {
        // A branch naming albums searches them whoever owns their assets; the other branch is the
        // key's own library, as a search without albums is.
        return await this.searchFilter({
          ...base,
          or: [{ type: { in: ["IMAGE", "VIDEO"] } }, { albumIds: { any: albumIds } }],
        });
      } catch (e) {
        // An album unshared since the list was fetched fails the whole search.
        if (!(e instanceof ImmichError) || e.upstream !== 400) throw e;
        this.albums = null;
        console.warn("shared albums: Immich refused the album search; searching the key's own assets only");
      }
    return this.searchFilter(base);
  }

  private async searchFilter(filter: Record<string, unknown>): Promise<AssetInfo[]> {
    const out: AssetInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const body = { filter, withExif: true, size: 1000, ...(cursor ? { cursor } : {}) };
      const res = await this.call("/api/search/metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { assets: { items: RawAsset[]; nextCursor?: string | null } };
      for (const a of data.assets.items) if (a.type === "IMAGE" || a.type === "VIDEO") out.push(this.toInfo(a));
      cursor = data.assets.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out.sort((a, b) => Date.parse(a.taken_at ?? "") - Date.parse(b.taken_at ?? ""));
  }

  /**
   * The bytes of one size of an asset, with `range` passed through. Resolves once Immich's
   * headers arrived; the body is cut once the body deadline passes.
   */
  async media(id: string, size: MediaSize, range: string | null): Promise<Response> {
    const path =
      size === "video"
        ? `/api/assets/${encodeURIComponent(id)}/video/playback`
        : `/api/assets/${encodeURIComponent(id)}/thumbnail?size=${size === "thumb" ? "thumbnail" : "preview"}&edited=true`;
    const headers = new Headers({ "x-api-key": this.key });
    if (range) headers.set("range", range);
    const abort = new AbortController();
    // One deadline for the headers, another for the whole body, so a stalled or endless stream
    // cannot hold a connection here and one to Immich forever.
    const headersTimer = setTimeout(() => abort.abort(), this.timeoutMs);
    const bodyTimer = setTimeout(() => abort.abort(), this.bodyTimeoutMs);
    try {
      let res = await fetch(this.url + path, { headers, signal: abort.signal, redirect: "manual" });
      // Immich answers some sizes with a redirect to another size of the same asset.
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, this.url + path);
        if (next.origin !== new URL(this.url).origin) throw new ImmichError("Immich redirected off-site", 502);
        res = await fetch(next, { headers, signal: abort.signal, redirect: "manual" });
      }
      clearTimeout(headersTimer);
      if (!res.body) {
        clearTimeout(bodyTimer);
        return res;
      }
      const body = res.body.pipeThrough(
        new TransformStream({
          flush() {
            clearTimeout(bodyTimer);
          },
        }),
      );
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      clearTimeout(headersTimer);
      clearTimeout(bodyTimer);
      if (e instanceof ImmichError) throw e;
      throw new ImmichError(`Immich unreachable: ${(e as Error).message}`, 502);
    }
  }
}
