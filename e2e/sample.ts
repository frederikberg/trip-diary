// Sample notes and media on the sample hike's tracks, for the self-test and for local development.
import type { Day, Note } from "../src/shared/api";
import fixture from "../test/fixtures/hike.json";
import type { FakeImmich, TestApp } from "../test/helpers";

const days = fixture.days as Day[];

/** A point a few metres beside the track of `day`, `f` of the way along it. */
function along(day: number, f: number): { lat: number; lon: number; t: string } {
  const tr = days[day - 1]?.track as Day["track"];
  const p = tr[Math.round(f * (tr.length - 1))] as Day["track"][number];
  return { lat: +(p[0] + 0.00012).toFixed(6), lon: +(p[1] + 0.0001).toFixed(6), t: p[3] };
}

const COLOURS = ["#7a9e7e", "#8d7b68", "#5f7f99", "#a3864f", "#6f8f62", "#94706b", "#57756b"];
let assetNo = 0;
function asset(immich: FakeImmich, type: "IMAGE" | "VIDEO", w: number, h: number, t: string): string {
  assetNo++;
  const id = `${String(assetNo).padStart(8, "0")}-0000-4000-8000-${String(assetNo).padStart(12, "0")}`;
  immich.assets.set(id, {
    id,
    type,
    width: w,
    height: h,
    taken_at: new Date(t).toISOString(),
    colour: COLOURS[assetNo % COLOURS.length],
    duration_ms: type === "VIDEO" ? 14_000 : undefined,
  });
  return id;
}

interface SampleNote {
  number: number;
  /** On a day's track, or a time for a note without a place. */
  at: [day: number, f: number] | string;
  title: string;
  text: string;
  media: ("p" | "l" | "v")[];
}

/** Numbered out of timeline order on purpose: numbers are given when placed, the strip orders by time. */
const NOTES: SampleNote[] = [
  {
    number: 1,
    at: [1, 0.02],
    title: "Start im Dorf",
    text: "Der Zug war pünktlich, der Rucksack zu schwer. Erste Schritte raus aus der Stadt, und sofort wird es leiser.",
    media: ["l"],
  },
  {
    number: 6,
    at: [1, 0.45],
    title: "Pause am Bach",
    text: "Schuhe aus, Füße ins kalte Wasser. Zwanzig Minuten nur zuhören.\n\nDanach ging es **steil** bergauf.",
    media: ["p", "l", "p"],
  },
  {
    number: 2,
    at: [1, 0.82],
    title: "Erster Blick ins Tal",
    text: "Kurz vor dem Lagerplatz öffnet sich der Wald.",
    media: [],
  },
  {
    number: 3,
    at: [2, 0.3],
    title: "Nebel über der Burgruine",
    text: "Morgens alles weiß. Die Burg tauchte erst auf, als wir fast davor standen.",
    media: ["l", "p"],
  },
  {
    number: 7,
    at: [2, 0.62],
    title: "Brombeeren",
    text: "Ein ganzer Hang voller Brombeeren, mitten im Oktober.",
    media: ["p"],
  },
  {
    number: 4,
    at: [3, 0.25],
    title: "Gehmeditation im Buchenwald",
    text: "Eine Stunde lang nur gehen, atmen, Schritt für Schritt.\n\n- langsam\n- ohne Ziel\n- barfuß im Laub",
    media: [],
  },
  {
    number: 5,
    at: [3, 0.7],
    title: "Aussichtspunkt, 650 m",
    text: "Der höchste Punkt der Tour. Wind, Weite, ein kurzes Video vom Ausblick.",
    media: ["v", "l", "l"],
  },
  { number: 8, at: [4, 0.5], title: "Quelle am Wegrand", text: "Wasser aufgefüllt, endlich.", media: ["p"] },
  { number: 10, at: [5, 0.3], title: "Lichtung", text: "Sonne auf dem Moos.", media: ["v", "l", "v"] },
  { number: 9, at: [5, 0.78], title: "", text: "", media: [] },
  {
    number: 11,
    at: "2026-10-17T21:30:00+02:00",
    title: "Gedanken am Abend",
    text: "Ohne Ort: nur die Zeit stellt diese Notiz in die Reihe.",
    media: [],
  },
];

const DAY_TEXT: Record<number, string> = {
  1: "Ankommen. Wildcamp unter Kiefern, früh im Schlafsack.",
  3: "Der längste Aufstieg, der schönste Abend.",
  5: "Letzte Nacht draußen.",
};

/** Adds the sample notes through the admin API; returns them in creation order. */
export async function addSample(app: TestApp, immich: FakeImmich, slug = "sample"): Promise<Note[]> {
  const out: Note[] = [];
  for (const n of NOTES) {
    const pos = typeof n.at === "string" ? { lat: null, lon: null, t: n.at } : along(...n.at);
    const res = await app.call(`/api/admin/trips/${slug}/notes`, {
      method: "POST",
      admin: true,
      json: {
        lat: pos.lat,
        lon: pos.lon,
        ...(typeof n.at === "string" ? { at: n.at } : {}),
        number: n.number,
        title: n.title,
        text: n.text,
        created: "2026-10-20T09:00:00Z",
      },
    });
    if (res.status !== 201) throw new Error(`note ${n.number}: ${res.status} ${await res.text()}`);
    const note = (await res.json()) as Note;
    for (const [i, kind] of n.media.entries()) {
      const t = new Date(Date.parse(pos.t) + i * 60_000).toISOString();
      const id =
        kind === "v"
          ? asset(immich, "VIDEO", 1280, 720, t)
          : kind === "p"
            ? asset(immich, "IMAGE", 3024, 4032, t)
            : asset(immich, "IMAGE", 4032, 3024, t);
      const r = await app.call(`/api/admin/trips/${slug}/notes/${note.key}/media`, {
        method: "POST",
        admin: true,
        json: { immich_id: id },
      });
      if (r.status !== 201) throw new Error(`media of ${n.number}: ${r.status} ${await r.text()}`);
    }
    out.push(note);
  }
  for (const [day, text] of Object.entries(DAY_TEXT))
    await app.call(`/api/admin/trips/${slug}/notes/d${day}`, { method: "PATCH", admin: true, json: { text } });
  return out;
}
