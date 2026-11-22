// The pieces every HTTP handler shares: the error type, response helpers and body validation.
import type { ApiError } from "../shared/api";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Partial<ApiError> = {},
  ) {
    super(message);
  }
}

export const BASE_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "strict-origin",
  "x-content-type-options": "nosniff",
};

/** Media are never documents: whatever a future format holds, it runs nothing and loads nothing. */
export const MEDIA_CSP = { "content-security-policy": "default-src 'none'; sandbox" };

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

export const empty = (status = 204, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { ...BASE_HEADERS, ...headers } });

export const text = (
  body: string,
  status: number,
  type = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
) => new Response(body, { status, headers: { ...BASE_HEADERS, "content-type": type, ...headers } });

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
  return v as Record<string, unknown>;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  try {
    return obj(JSON.parse(raw || "null"));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body is not valid JSON");
  }
}

export function only(b: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new HttpError(400, `unknown field ${k}`);
}

export function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return v;
}

export const optStr = (v: unknown, field: string, max: number) => (v == null ? null : str(v, field, max));

export function coord(v: unknown, field: "lat" | "lon"): number {
  const lim = field === "lat" ? 90 : 180;
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > lim)
    throw new HttpError(400, `${field} is invalid`);
  return Math.round(v * 1e6) / 1e6;
}

export function int(v: unknown, field: string, min = 0): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min)
    throw new HttpError(400, `${field} must be an integer ≥ ${min}`);
  return v;
}

export function record(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `${field} must be an object`);
  return v as Record<string, unknown>;
}
