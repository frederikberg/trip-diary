// Capability tokens: 16 random bytes as 22 characters of base64url. Only their SHA-256 is looked
// up; comparing hashes of equal length keeps the comparison independent of the secret's content.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export const newToken = (): string => randomBytes(16).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Constant-time equality of two secrets of any length. */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
