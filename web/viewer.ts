// The fullscreen viewer: every photo and video of the trip in timeline order. Closing it lands on
// the note that owns the item shown last.
import PhotoSwipe, { type SlideData } from "photoswipe";
import type { Media, Note } from "../src/shared/api";
import { dayNo, esc, icon, label, noteTitle, toast } from "./util";

interface Slide {
  note: Note;
  /** Index within the note. */
  i: number;
  m: Media;
}

export interface ViewerOptions {
  notes: Note[];
  key: string;
  index: number;
  editable: boolean;
  /** The note owning the last item shown. */
  onClose(key: string): void;
  onCaption?(note: Note, m: Media): Promise<boolean>;
  onRemove?(note: Note, m: Media): void;
}

let open: PhotoSwipe | null = null;
export const viewerOpen = () => open != null;
export const closeViewer = () => open?.close();

async function save(s: Slide): Promise<void> {
  const url = s.m.type === "video" ? (s.m.video as string) : s.m.preview;
  try {
    const blob = await (await fetch(url)).blob();
    const ext = s.m.type === "video" ? "mp4" : blob.type === "image/png" ? "png" : "jpg";
    const name = `${s.note.key}-${s.i + 1}.${ext}`;
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] }).catch(() => {});
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch {
    toast("Speichern hat nicht geklappt.");
  }
}

export function openViewer(o: ViewerOptions): void {
  const slides: Slide[] = o.notes.flatMap((note) => note.media.map((m, i) => ({ note, i, m })));
  const start = slides.findIndex((s) => s.note.key === o.key && s.i === o.index);
  if (start < 0) return;
  const data: SlideData[] = slides.map((s) =>
    s.m.type === "video"
      ? {
          html: `<div class="pswp__vid"><video src="${esc(s.m.video)}" poster="${esc(s.m.preview)}" controls playsinline preload="none"></video></div>`,
        }
      : {
          src: s.m.preview,
          msrc: s.m.preview,
          width: s.m.width ?? 1440,
          height: s.m.height ?? 1080,
          alt: s.m.caption ?? "",
        },
  );
  const pswp = new PhotoSwipe({
    dataSource: data,
    index: start,
    bgOpacity: 1,
    showHideAnimationType: "none",
    zoomAnimationDuration: 180,
    wheelToZoom: true,
    pinchToClose: true,
    closeOnVerticalDrag: true,
    padding: { top: 56, bottom: 72, left: 0, right: 0 },
    counter: false,
    zoom: false,
    preloaderDelay: 500,
    errorMsg: "Das Bild lässt sich gerade nicht laden.",
    closeTitle: "Schließen",
    arrowPrevTitle: "Vorheriges",
    arrowNextTitle: "Nächstes",
  });
  const current = () => slides[pswp.currIndex] as Slide;
  pswp.on("uiRegister", () => {
    pswp.ui?.registerElement({
      name: "note",
      appendTo: "root",
      onInit: (el) => {
        el.className = "pswp__note";
        const upd = () => {
          const s = current();
          el.innerHTML = `<b>${s.note.kind === "day" ? `${icon.flag}${dayNo(s.note.day)}` : s.note.number}</b><span>${esc(noteTitle(s.note))}</span>`;
        };
        pswp.on("change", upd);
        upd();
      },
    });
    pswp.ui?.registerElement({
      name: "cap",
      appendTo: "root",
      onInit: (el) => {
        el.className = "pswp__cap";
        const upd = () => {
          const s = current();
          const n = s.note.media.length;
          el.innerHTML = `${s.m.caption ? `<p>${esc(s.m.caption)}</p>` : ""}<small>${esc(label(s.note))} · ${s.i + 1} von ${n} · ${pswp.currIndex + 1}/${slides.length} der Reise</small>`;
        };
        pswp.on("change", upd);
        upd();
      },
    });
    pswp.ui?.registerElement({
      name: "save",
      order: 8,
      isButton: true,
      title: "Sichern",
      html: icon.save,
      className: "pswp__button--icon",
      onClick: () => save(current()),
    });
    if (o.editable && o.onCaption && o.onRemove) {
      const caption = o.onCaption;
      const remove = o.onRemove;
      pswp.ui?.registerElement({
        name: "caption",
        order: 7,
        isButton: true,
        title: "Bildunterschrift",
        html: icon.caption,
        className: "pswp__button--icon",
        onClick: async () => {
          if (await caption(current().note, current().m)) pswp.dispatch("change");
        },
      });
      pswp.ui?.registerElement({
        name: "remove",
        order: 6,
        isButton: true,
        title: "Aus der Notiz entfernen",
        html: icon.trash,
        className: "pswp__button--icon",
        onClick: () => {
          const s = current();
          pswp.close();
          remove(s.note, s.m);
        },
      });
    }
  });
  // Every video starts when it comes into view, with sound: this view is opened or moved by a tap or
  // a key. A browser that refuses sound without a fresh tap gets it muted and says so.
  const videoOf = (c: { element?: HTMLElement }) => c.element?.querySelector("video") ?? null;
  const startWithSound = (v: HTMLVideoElement) => {
    v.muted = false;
    v.play().catch((e: unknown) => {
      if ((e as Error).name !== "NotAllowedError") return;
      v.muted = true;
      v.play().catch(() => {});
      toast("Ton ist aus: im Player den Lautsprecher antippen.", 4000);
    });
  };
  pswp.on("contentActivate", ({ content }) => {
    const v = videoOf(content);
    if (v) startWithSound(v);
  });
  pswp.on("contentDeactivate", ({ content }) => videoOf(content)?.pause());
  // Space plays and pauses; the video's own controls and a focused button keep their native space.
  pswp.on("keydown", ({ originalEvent: e }) => {
    const t = e.target as HTMLElement;
    if (e.key !== " " || t.closest("video")) return;
    const v = videoOf(pswp.currSlide?.content ?? {});
    if (!v) return;
    e.preventDefault();
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  });
  const noSpaceClick = (e: KeyboardEvent) => {
    if (e.key === " " && !(e.target as HTMLElement).closest("video") && videoOf(pswp.currSlide?.content ?? {}))
      e.preventDefault();
  };
  document.addEventListener("keyup", noSpaceClick, true);
  pswp.on("close", () => {
    for (const v of document.querySelectorAll<HTMLVideoElement>(".pswp video")) v.pause();
    o.onClose(current().note.key);
  });
  pswp.on("destroy", () => {
    document.removeEventListener("keyup", noSpaceClick, true);
    open = null;
  });
  open = pswp;
  pswp.init();
}
