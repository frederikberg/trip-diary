// Sample notes and media on the sample hike's tracks, for the self-test and for local development.
import type { Day, DayPut, Note } from "../src/shared/api";
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

/** A sixth day of two rides with a train in between: `breaks` marks where the second ride starts. */
function twoRideDay(): DayPut {
  const ride = (from: [number, number], to: [number, number], start: string): Day["track"] =>
    Array.from({ length: 24 }, (_, i) => {
      const f = i / 23;
      const wobble = Math.sin(f * 9) * 0.0012;
      return [
        +(from[0] + (to[0] - from[0]) * f + wobble).toFixed(6),
        +(from[1] + (to[1] - from[1]) * f).toFixed(6),
        300 + Math.round(f * 30),
        new Date(Date.parse(start) + i * 150_000).toISOString(),
      ];
    });
  const track = [
    ...ride([49.8663, 7.476], [49.882, 7.51], "2026-10-20T09:00:00+02:00"),
    ...ride([49.93, 7.6], [49.945, 7.64], "2026-10-20T11:00:00+02:00"),
  ];
  return {
    date: "2026-10-20",
    track,
    breaks: [24],
    stats: {
      km: 5.2,
      ascent_m: 60,
      descent_m: 30,
      start_time: track[0]?.[3] as string,
      end_time: track.at(-1)?.[3] as string,
      moving_time_min: 40,
      elapsed_time_min: 175,
      min_ele: 300,
      max_ele: 330,
    },
    end: { lat: 49.945, lon: 7.64, camp_type: null, name: null },
    source: null,
  };
}

/** Adds the sample notes through the admin API; returns them in creation order. */
export async function addSample(app: TestApp, immich: FakeImmich, slug = "sample"): Promise<Note[]> {
  const out: Note[] = [];
  const day = await app.call(`/api/admin/trips/${slug}/days/6`, { method: "PUT", admin: true, json: twoRideDay() });
  if (day.status !== 200) throw new Error(`day 6: ${day.status} ${await day.text()}`);
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
