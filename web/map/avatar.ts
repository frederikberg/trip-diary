// A chosen photo becomes a small square JPEG in the browser: the phone's camera picture never leaves
// the device. An <img> decodes it, which is what Safari handles best at any size, and applies the
// orientation stored in the photo.
import type { Entry } from "../../src/shared/api";
import { avatar, esc, icon } from "./util";

const SIZE = 256;
const QUALITY = 0.85;

/** The middle square of the picture, as a JPEG. Rejects what the browser cannot read, an unconverted HEIC say. */
export async function squareJpeg(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    return await new Promise((done, fail) =>
      canvas.toBlob((b) => (b ? done(b) : fail(new Error("no picture"))), "image/jpeg", QUALITY),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function avatarBody(e: Entry, preview: string | null): string {
  if (preview)
    return `<div class="av-big"><span class="av"><img src="${esc(preview)}" alt=""></span></div>
      <div class="actions"><button type="button" class="primary" data-act="avatar-save"><span>Speichern</span></button><button type="button" data-act="avatar-drop"><span>Abbrechen</span></button></div>`;
  return `<div class="av-big">${avatar(e)}</div>
    <div class="actions"><button type="button" class="primary" data-act="avatar-pick">${icon.camera}<span>Foto wählen</span></button></div>
    <div class="emoji-line"><input id="avatar-emoji" aria-label="Emoji" placeholder="🙂" autocomplete="off" value="${esc(e.emoji ?? "")}"><button type="button" data-act="avatar-emoji">Emoji nehmen</button></div>
    ${e.avatar || e.emoji ? `<div class="actions"><button type="button" data-act="avatar-clear"><span>Nur Initialen</span></button></div>` : ""}`;
}
