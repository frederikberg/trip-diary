// The view and edit API for the page's own token.
import type { ApiError, Media, Note, NoteCreate, NotePatch, Suggestion, TripView } from "../src/shared/api";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

export class Api {
  readonly base: string;
  private etag: string | null = null;

  constructor(readonly token: string) {
    this.base = `/api/t/${token}`;
  }

  get readUrl(): string {
    return `${location.origin}/${this.token}`;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
    const res = await fetch(this.base + path, { ...init, headers });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
    return body as T;
  }

  /** The trip, or null when it did not change since the last call. */
  async view(): Promise<TripView | null> {
    const headers = new Headers();
    if (this.etag) headers.set("if-none-match", this.etag);
    const res = await fetch(this.base, { headers, cache: "no-cache" });
    if (res.status === 304) return null;
    if (!res.ok) throw new ApiFailure(res.status, await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
    this.etag = res.headers.get("etag");
    return (await res.json()) as TripView;
  }

  createNote(body: NoteCreate): Promise<Note> {
    return this.req("/notes", { method: "POST", body: JSON.stringify(body) });
  }

  patchNote(key: string, body: NotePatch, rev?: number): Promise<Note> {
    return this.req(`/notes/${key}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: rev == null ? {} : { "if-match": String(rev) },
    });
  }

  deleteNote(key: string): Promise<void> {
    return this.req(`/notes/${key}`, { method: "DELETE" });
  }

  attach(key: string, immichId: string): Promise<Media> {
    return this.req(`/notes/${key}/media`, { method: "POST", body: JSON.stringify({ immich_id: immichId }) });
  }

  patchMedia(key: string, id: number, body: { caption?: string | null; position?: number }): Promise<Media> {
    return this.req(`/notes/${key}/media/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  deleteMedia(key: string, id: number): Promise<void> {
    return this.req(`/notes/${key}/media/${id}`, { method: "DELETE" });
  }

  /** The trip's Immich assets taken in [from, to), oldest first. */
  suggest(from: Date, to: Date): Promise<Suggestion[]> {
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    return this.req(`/suggest?${q}`);
  }

  thumb(immichId: string): string {
    return `${this.base}/immich/${immichId}/thumb`;
  }
}
