// The link-preview picture of a map: the committed base map (`scripts/map-preview.ts` renders it
// with no pins), a disc for every place on it, encoded as a JPEG. There is no canvas on the server,
// so the pixels are plain RGBA bytes that `Bun.Image` decodes into and encodes out of.
import { inflateSync } from "node:zlib";
import { PALETTE } from "../shared/palette";

/** The base map's fixed section: a square centred on a point, at a MapLibre zoom level. */
export const SECTION = { lat: 51.8, lon: 9.7, zoom: 4.8, size: 1200, deviceScale: 2 } as const;

const RADIUS = 38;
const RING = 5;
const JPEG_QUALITY = 80;
const AVATAR_MAX_PIXELS = 4096 * 4096;

export interface Raster {
  width: number;
  height: number;
  /** Row-major RGBA. */
  px: Uint8Array;
}

export interface Pin {
  lat: number;
  lon: number;
  /** Index into the palette. */
  color: number;
  /** The entry's picture as stored (JPEG, PNG or WebP). */
  avatar: Uint8Array | null;
}

const mercatorY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** The base map's pixel of a coordinate; null when it lies outside the section. */
export function project(lat: number, lon: number): [number, number] | null {
  const world = 512 * 2 ** SECTION.zoom * SECTION.deviceScale;
  const x = SECTION.size / 2 + ((lon - SECTION.lon) / 360) * world;
  const y = SECTION.size / 2 + (mercatorY(lat) - mercatorY(SECTION.lat)) * world;
  return x >= 0 && x < SECTION.size && y >= 0 && y < SECTION.size ? [x, y] : null;
}

/** Decodes an image into pixels by way of a PNG without compression. */
export async function decode(image: Bun.Image): Promise<Raster> {
  return parsePng(await image.png({ compressionLevel: 0 }).bytes());
}

function parsePng(png: Uint8Array): Raster {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let i = 8; i + 8 <= png.length; ) {
    const len = dv.getUint32(i);
    const kind = String.fromCharCode(...png.subarray(i + 4, i + 8));
    const data = png.subarray(i + 8, i + 8 + len);
    if (kind === "IHDR") {
      width = dv.getUint32(i + 8);
      height = dv.getUint32(i + 12);
      const [depth, type, , , interlace] = data.subarray(8, 13);
      channels = type === 6 ? 4 : type === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace) throw new Error("unsupported PNG layout");
    } else if (kind === "IDAT") idat.push(data);
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at] as number;
    const row = raw.subarray(at + 1, at + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (row[x - channels] as number) : 0;
      const b = prev[x] as number;
      const c = x >= channels ? (prev[x - channels] as number) : 0;
      let v = row[x] as number;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      px[o] = row[s] as number;
      px[o + 1] = row[s + 1] as number;
      px[o + 2] = row[s + 2] as number;
      px[o + 3] = channels === 4 ? (row[s + 3] as number) : 255;
    }
    prev = row;
  }
  return { width, height, px };
}

/** The picture as a `size` square (an entry's picture is stored square). */
async function avatarRaster(bytes: Uint8Array, size: number): Promise<Raster> {
  return decode(new Bun.Image(bytes, { maxPixels: AVATAR_MAX_PIXELS }).resize(size, size, { fit: "inside" }));
}

function hex(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blend(px: Uint8Array, o: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  px[o] = (px[o] as number) + (r - (px[o] as number)) * a;
  px[o + 1] = (px[o + 1] as number) + (g - (px[o + 1] as number)) * a;
  px[o + 2] = (px[o + 2] as number) + (b - (px[o + 2] as number)) * a;
}

/** Calls `paint(offset, distance, dx, dy)` for every pixel within `radius + 1` of the centre. */
function eachPixel(
  img: Raster,
  cx: number,
  cy: number,
  radius: number,
  paint: (o: number, d: number, dx: number, dy: number) => void,
): void {
  const reach = Math.ceil(radius) + 1;
  for (let y = Math.max(0, Math.floor(cy) - reach); y <= Math.min(img.height - 1, Math.floor(cy) + reach); y++)
    for (let x = Math.max(0, Math.floor(cx) - reach); x <= Math.min(img.width - 1, Math.floor(cx) + reach); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      paint((y * img.width + x) * 4, Math.hypot(dx, dy), dx, dy);
    }
}

const edge = (radius: number, d: number) => Math.min(1, Math.max(0, radius - d + 0.5));

function drawPin(img: Raster, x: number, y: number, color: string, face: Raster | null): void {
  const [r, g, b] = hex(color);
  eachPixel(img, x, y + 3, RADIUS + 8, (o, d) =>
    blend(img.px, o, 0, 0, 0, 0.28 * Math.min(1, Math.max(0, (RADIUS + 7 - d) / 8))),
  );
  eachPixel(img, x, y, RADIUS, (o, d) => blend(img.px, o, 255, 255, 255, edge(RADIUS, d)));
  const inner = RADIUS - RING;

  eachPixel(img, x, y, inner, (o, d, dx, dy) => {
    const a = edge(inner, d);
    const fx = face ? Math.floor(dx + face.width / 2) : -1;
    const fy = face ? Math.floor(dy + face.height / 2) : -1;
    if (face && fx >= 0 && fy >= 0 && fx < face.width && fy < face.height) {
      const f = (fy * face.width + fx) * 4;
      const alpha = ((face.px[f + 3] as number) / 255) * a;
      blend(img.px, o, r, g, b, a);
      blend(img.px, o, face.px[f] as number, face.px[f + 1] as number, face.px[f + 2] as number, alpha);
    } else blend(img.px, o, r, g, b, a);
  });
}

/** A 24-bit BMP, which `Bun.Image` decodes and re-encodes as JPEG. */
function bmp(img: Raster): Uint8Array {
  const row = img.width * 3;
  const padded = row + ((4 - (row % 4)) % 4);
  const out = new Uint8Array(54 + padded * img.height);
  const dv = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, img.width, true);
  dv.setInt32(22, img.height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  for (let y = 0; y < img.height; y++) {
    let o = 54 + (img.height - 1 - y) * padded;
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      out[o++] = img.px[s + 2] as number;
      out[o++] = img.px[s + 1] as number;
      out[o++] = img.px[s] as number;
    }
  }
  return out;
}

/**
 * The base map with a disc per pin that lies in the section. The northern pins go first so a
 * southern one covers them; a pin with a picture shows it, any other (or one whose picture does not
 * decode) its colour.
 */
export async function composePreview(base: Raster, pins: Pin[]): Promise<Uint8Array> {
  const img: Raster = { width: base.width, height: base.height, px: base.px.slice() };
  const inside = pins
    .flatMap((p) => {
      const at = project(p.lat, p.lon);
      return at ? [{ ...p, at }] : [];
    })
    .sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const faces = new Map<Uint8Array, Raster | null>();
  for (const p of inside) {
    if (p.avatar && !faces.has(p.avatar))
      faces.set(p.avatar, await avatarRaster(p.avatar, 2 * (RADIUS - RING)).catch(() => null));
    const [x, y] = p.at;
    drawPin(img, x, y, PALETTE[p.color % PALETTE.length] as string, p.avatar ? (faces.get(p.avatar) ?? null) : null);
  }
  return new Bun.Image(bmp(img)).jpeg({ quality: JPEG_QUALITY, progressive: true }).bytes();
}
