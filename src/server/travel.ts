// Travel times from the two outside services, through the `travel_time` cache: cars from an OSRM
// table, trains from the DB Navigator API, each at one request per interval, process-wide. Nothing else
// talks to those hosts.
import { randomUUID } from "node:crypto";
import type { MeetMode } from "../shared/api";
import type { Config } from "./config";
import type { Store } from "./db";

const JOURNEY_TYPE = "application/x.db.vendo.mob.verbindungssuche.v9+json";
/** OSRM's table takes this many coordinates in one request. */
const MAX_COORDS = 100;
const DAY_MS = 86_400_000;

/** The service failed; `no connection` is an answer, not this. */
export class TravelError extends Error {}

export interface Point {
  lat: number;
  lon: number;
}

export interface Travel {
  /** Minutes by car from every source to every destination; null where there is no way. */
  carMatrix(sources: Point[], destinations: Point[]): Promise<(number | null)[][]>;
  /** Whether `trainMinutes` answers without asking the service. */
  trainCached(from: string, to: string): boolean;
  /** Minutes of the fastest journey without a bus at `at`, between two EVA numbers; null without one. */
  trainMinutes(from: string, to: string, at: string): Promise<number | null>;
}

const carKey = (p: Point) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

interface Journey {
  verbindung?: { reiseDauer?: number; verbindungsAbschnitte?: { kurztext?: string; typ?: string }[] };
}

const hasBus = (j: Journey) =>
  (j.verbindung?.verbindungsAbschnitte ?? []).some((s) => /bus/i.test(s.kurztext ?? "") || /bus/i.test(s.typ ?? ""));

/** The fastest journey without a bus, else the fastest; null without any. */
export function fastest(journeys: Journey[]): number | null {
  const timed = journeys.filter((j) => j.verbindung?.reiseDauer != null);
  const pool = timed.some((j) => !hasBus(j)) ? timed.filter((j) => !hasBus(j)) : timed;
  if (!pool.length) return null;
  return Math.round(Math.min(...pool.map((j) => j.verbindung?.reiseDauer as number)) / 60);
}

/** Runs one request after the one before it, with the interval between them, process-wide. */
function gate(intervalMs: number) {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {}).then(() => Bun.sleep(intervalMs));
    return run;
  };
}

export function createTravel(config: Config, store: Store, userAgent: string, now = () => new Date()): Travel {
  const { car_url, car_interval_ms, train_url, timeout_ms, train_interval_ms } = config.meet;
  const daysAgo = (days: number) => new Date(now().getTime() - days * DAY_MS).toISOString();
  const cached = (mode: MeetMode, from: string, to: string) =>
    store.travelTime(mode, from, to, daysAgo(config.meet.cache_days), daysAgo(config.meet.cache_none_days));
  const carGate = gate(car_interval_ms);
  const trainGate = gate(train_interval_ms);

  async function carTable(sources: Point[], destinations: Point[]): Promise<(number | null)[][]> {
    const coords = [...sources, ...destinations].map((p) => `${p.lon},${p.lat}`).join(";");
    const src = sources.map((_, i) => i).join(";");
    const dst = destinations.map((_, i) => i + sources.length).join(";");
    let body: { code?: string; durations?: (number | null)[][] };
    try {
      const res = await fetch(`${car_url}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}`, {
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(timeout_ms),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new TravelError(`car router: ${e instanceof Error ? e.message : e}`);
    }
    if (body.code !== "Ok" || !body.durations) throw new TravelError(`car router: ${body.code}`);
    return body.durations.map((row) => row.map((s) => (s == null ? null : Math.round(s / 60))));
  }

  return {
    async carMatrix(sources, destinations) {
      const known = sources.map((s) => destinations.map((d) => cached("car", carKey(s), carKey(d))));
      if (known.every((row) => row.every(Boolean))) return known.map((row) => row.map((c) => c?.minutes ?? null));
      const room = MAX_COORDS - sources.length;
      if (room < 1) throw new TravelError("too many members for one table");
      const out: (number | null)[][] = sources.map(() => []);
      for (let i = 0; i < destinations.length; i += room) {
        const part = destinations.slice(i, i + room);
        const rows = await carGate(() => carTable(sources, part));
        for (const [s, row] of rows.entries()) (out[s] as (number | null)[]).push(...row);
      }
      const t = now().toISOString();
      for (const [i, s] of sources.entries())
        for (const [j, d] of destinations.entries())
          store.putTravelTime("car", carKey(s), carKey(d), out[i]?.[j] ?? null, null, t);
      return out;
    },

    trainCached: (from, to) => cached("train", from, to) != null,

    async trainMinutes(from, to, at) {
      const hit = cached("train", from, to);
      if (hit) return hit.minutes;
      const station = (eva: string) => `A=1@L=${eva}@`;
      const journeys = await trainGate(async () => {
        try {
          const res = await fetch(`${train_url}/angebote/fahrplan`, {
            method: "POST",
            headers: {
              "content-type": JOURNEY_TYPE,
              accept: JOURNEY_TYPE,
              "accept-language": "de",
              "x-correlation-id": `${randomUUID()}_${randomUUID()}`,
              "user-agent": userAgent,
            },
            signal: AbortSignal.timeout(timeout_ms),
            body: JSON.stringify({
              autonomeReservierung: false,
              einstiegsTypList: ["STANDARD"],
              fahrverguenstigungen: { deutschlandTicketVorhanden: false, nurDeutschlandTicketVerbindungen: false },
              klasse: "KLASSE_2",
              reisendenProfil: { reisende: [{ ermaessigungen: [], reisendenTyp: "ERWACHSENER" }] },
              reservierungsKontingenteVorhanden: false,
              reiseHin: {
                wunsch: {
                  abgangsLocationId: station(from),
                  zielLocationId: station(to),
                  verkehrsmittel: ["ALL"],
                  alternativeHalteBerechnung: true,
                  zeitWunsch: { reiseDatum: at, zeitPunktArt: "ABFAHRT" },
                  economic: true,
                },
              },
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return ((await res.json()) as { verbindungen?: Journey[] }).verbindungen ?? [];
        } catch (e) {
          throw new TravelError(`train service: ${e instanceof Error ? e.message : e}`);
        }
      });
      const minutes = fastest(journeys);
      store.putTravelTime("train", from, to, minutes, at, now().toISOString());
      return minutes;
    },
  };
}
