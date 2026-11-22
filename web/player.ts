// Inline playback of the videos in the open note, and the two switches (autoplay, mute) kept in
// this browser. One video plays at a time; with several in a note they follow one another and the
// row scrolls to the one playing.

const STORE = "trip-video";

interface Prefs {
  autoplay: boolean;
  mute: boolean;
}

const DEFAULTS: Prefs = { autoplay: true, mute: true };

function readPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    // Private mode: the switches then last until the page closes.
  }
}

/** The two switches, shown above a media row that holds a video. */
export function switchesHtml(): string {
  const p = readPrefs();
  const sw = (name: keyof Prefs, text: string) =>
    `<button class="sw" data-vsw="${name}" aria-pressed="${p[name]}">${text}</button>`;
  return `<div class="vsw">${sw("autoplay", "Autoplay")}${sw("mute", "Stumm")}</div>`;
}

export interface Player {
  /** Starts the note's first video when autoplay is on; takes up where a re-render of the same note left off. */
  attach(key: string): void;
  /** Stops every video and frees its connection; `keep` remembers where the note's video stood, for a re-render of the same note. */
  release(keep: boolean): void;
  /** Play or pause the video in view; false when the note has none. */
  toggle(): boolean;
  /** A tile was tapped. */
  tap(index: number): void;
  pause(): void;
}

export function createPlayer(root: HTMLElement): Player {
  let prefs = readPrefs();
  let saved: { key: string; i: number; t: number; playing: boolean } | null = null;
  let key = "";
  /** The video of this note played last, playing or paused. */
  let last: HTMLElement | null = null;

  const tiles = () => [...root.querySelectorAll<HTMLElement>(".m.vid")];
  const video = (t: HTMLElement) => t.querySelector("video") as HTMLVideoElement;
  const tileOf = (v: Element) => v.closest<HTMLElement>(".m.vid") as HTMLElement;
  const current = () => tiles().find((t) => !video(t).paused) ?? null;

  function showSwitches() {
    for (const b of root.querySelectorAll<HTMLElement>("[data-vsw]")) {
      const on = b.dataset.vsw === "mute" ? [...root.querySelectorAll("video")].every((v) => v.muted) : prefs.autoplay;
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /** The row scrolls so the tile sits at its start, like a snap. */
  function reveal(t: HTMLElement, smooth: boolean) {
    const row = t.parentElement as HTMLElement;
    const left = t.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - 16;
    row.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "instant" });
  }

  /** Plays with the mute switch's choice; a browser that refuses sound without a tap gets it muted, and the switch shows that. */
  function start(t: HTMLElement) {
    const v = video(t);
    v.muted = prefs.mute;
    const p = v.play();
    p?.catch((e: unknown) => {
      if ((e as Error).name !== "NotAllowedError" || v.muted) return;
      v.muted = true;
      v.play().catch(() => {});
      showSwitches();
    });
  }

  root.addEventListener(
    "play",
    (e) => {
      const t = tileOf(e.target as Element);
      if (!t) return;
      for (const o of tiles()) if (o !== t) video(o).pause();
      t.classList.add("playing");
      last = t;
      const next = tiles()[tiles().indexOf(t) + 1];
      if (next) video(next).preload = "metadata";
    },
    true,
  );
  root.addEventListener("playing", (e) => tileOf(e.target as Element)?.classList.add("on"), true);
  root.addEventListener("pause", (e) => tileOf(e.target as Element)?.classList.remove("playing"), true);
  root.addEventListener(
    "ended",
    (e) => {
      const all = tiles();
      const t = tileOf(e.target as Element);
      if (!t || !prefs.autoplay || all.length < 2) return;
      const next = all[(all.indexOf(t) + 1) % all.length] as HTMLElement;
      reveal(next, true);
      start(next);
    },
    true,
  );
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-vsw]");
    if (!b) return;
    const name = b.dataset.vsw as keyof Prefs;
    if (name === "mute") {
      // The switch shows what the videos are doing, which can differ from the stored choice after a refused unmute.
      prefs.mute = b.getAttribute("aria-pressed") !== "true";
      for (const v of root.querySelectorAll("video")) v.muted = prefs.mute;
    } else {
      prefs.autoplay = !prefs.autoplay;
    }
    writePrefs(prefs);
    showSwitches();
    if (name === "autoplay" && prefs.autoplay && !current()) {
      const first = tiles()[0];
      if (first) start(first);
    }
  });

  return {
    attach(k) {
      prefs = readPrefs();
      key = k;
      last = null;
      const all = tiles();
      for (const t of all) {
        const v = video(t);
        v.muted = prefs.mute;
        v.loop = all.length === 1;
      }
      showSwitches();
      const again = saved?.key === k && saved.i < all.length ? saved : null;
      saved = null;
      if (again) {
        const t = all[again.i] as HTMLElement;
        video(t).currentTime = again.t;
        if (again.playing) start(t);
        return;
      }
      const first = all[0];
      if (first && prefs.autoplay) {
        reveal(first, false);
        start(first);
      }
    },
    release(keep) {
      const all = tiles();
      const t = current() ?? last;
      saved = keep && t ? { key, i: all.indexOf(t), t: video(t).currentTime, playing: current() != null } : null;
      for (const o of all) {
        const v = video(o);
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    },
    toggle() {
      const t = current() ?? tiles()[0];
      if (!t) return false;
      if (video(t).paused) start(t);
      else video(t).pause();
      return true;
    },
    tap(i) {
      const t = tiles().find((x) => Number(x.dataset.i) === i);
      if (!t) return;
      if (video(t).paused) start(t);
      else video(t).pause();
    },
    pause() {
      for (const t of tiles()) video(t).pause();
    },
  };
}
