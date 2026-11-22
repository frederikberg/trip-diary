// Entry pictures: content-addressed per map, so the same picture is one row and a URL never changes
// what it shows. The type and the size come from the bytes, not from the request.
import { createHash } from "node:crypto";
import type { Store } from "./db";
import { BASE_HEADERS, HttpError, MEDIA_CSP } from "./http";

export interface AvatarLimits {
  bytes: number;
  px: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] as number) << 8) | (b[i + 1] as number);
const u24le = (b: Uint8Array, i: number) =>
  (b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return [u16be(b, i + 7), u16be(b, i + 5)];
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  if (chunk === "VP8 ")
    return [
      (((b[27] as number) << 8) | (b[26] as number)) & 0x3fff,
      (((b[29] as number) << 8) | (b[28] as number)) & 0x3fff,
    ];
  if (chunk === "VP8L") {
    const bits = (b[21] as number) | ((b[22] as number) << 8) | ((b[23] as number) << 16) | ((b[24] as number) << 24);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

export function sniff(b: Uint8Array): { type: string; size: [number, number] | null } | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", size: jpegSize(b) };
  if (b.length > 24 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n")
    return { type: "image/png", size: [u32be(b, 16), u32be(b, 20)] };
  if (b.length > 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP")
    return { type: "image/webp", size: webpSize(b) };
  return null;
}

/** Validates the picture and stores it; returns its id. */
export function storeAvatar(
  store: Store,
  mapId: number,
  bytes: Uint8Array,
  lim: AvatarLimits,
  created: string,
): string {
  if (bytes.length > lim.bytes) throw new HttpError(413, `a picture may have ${lim.bytes} bytes`);
  const kind = sniff(bytes);
  if (!kind) throw new HttpError(415, "a picture must be a JPEG, PNG or WebP");
  const [w, h] = kind.size ?? [0, 0];
  if (!w || !h || w > lim.px || h > lim.px) throw new HttpError(400, `a picture may be ${lim.px} pixels wide and high`);
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  store.putAvatar({ map_id: mapId, id, type: kind.type, bytes, created });
  return id;
}

export function avatarOut(store: Store, mapId: number, id: string): Response {
  const a = store.avatar(mapId, id);
  if (!a) throw new HttpError(404, "picture not found");
  return new Response(a.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      ...BASE_HEADERS,
      ...MEDIA_CSP,
      "content-type": a.type,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
