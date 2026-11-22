// The meeting point: the selection, the job that computes it, and the state every page reads. One
// job per map runs in this process; a restart loses it and the old result stays.
import type {
  MeetBasis,
  MeetCandidate,
  MeetJob,
  MeetLeg,
  MeetMember,
  MeetMemberPut,
  MeetMode,
  MeetResult,
  MeetState,
  MeetStation,
  Place,
} from "../shared/api";
import { isoInZone } from "../shared/time";
import type { Config } from "./config";
import type { EntryRow, MapRow, MeetMemberRow, Store } from "./db";
import { HttpError, int, only } from "./http";
import {
  closest,
  inBox,
  inputsHash,
  kmBetween,
  meanMinutes,
  nearest,
  nextDeparture,
  score,
  weightedMiddle,
} from "./meet-algo";
import stationList from "./stations.json";
import { type Travel, TravelError } from "./travel";

const BOX_KM = 100;
const TOP = 3;
/** The stations compared by car for a member far from all of them. */
const HOME_CHOICES = 6;
/** Beyond this the home station is more of a guess, and the result says so. */
const FAR_HOME_KM = 50;

interface Station extends MeetStation {
  candidate: boolean;
}

export interface MeetDeps {
  config: Config;
  store: Store;
  travel: Travel;
  now: () => Date;
}

export interface Meet {
  state(map: MapRow): MeetState;
  putMember(map: MapRow, entry: EntryRow, body: Record<string, unknown>): MeetState;
  deleteMember(map: MapRow, entry: EntryRow): MeetState;
  compute(map: MapRow): MeetState;
}

const hours = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;

export function createMeet({ config, store, travel, now }: MeetDeps): Meet {
  const stations = stationList as Station[];
  const jobs = new Map<number, MeetJob>();
  const nowIso = () => now().toISOString();
  const memberOut = ({ map_id: _, ...m }: MeetMemberRow): MeetMember => m;

  /** The members whose entries exist and have a place, with that place. */
  function resolved(mapId: number): MeetBasis[] {
    const rows = store.entries(mapId);
    return store.meetMembers(mapId).flatMap((m) => {
      const e = rows.find((r) => r.id === m.entry_id && !r.deleted_at);
      const places = e ? (JSON.parse(e.places) as Place[]) : [];
      const p = places.find((x) => x.id === m.place_id) ?? places[0];
      if (!e || !p) return [];
      return [{ entry_id: e.id, name: e.name, weight: m.weight, mode: m.mode, lat: p.lat, lon: p.lon }];
    });
  }

  function state(map: MapRow): MeetState {
    const live = resolved(map.id);
    const ids = new Set(live.map((m) => m.entry_id));
    const stored = store.meetResult(map.id);
    return {
      members: store
        .meetMembers(map.id)
        .filter((m) => ids.has(m.entry_id))
        .map(memberOut),
      centroid: weightedMiddle(live),
      result: stored ? (JSON.parse(stored.result) as MeetResult) : null,
      stale: stored != null && stored.inputs_hash !== inputsHash(live),
      job: jobs.get(map.id) ?? null,
    };
  }

  function putMember(map: MapRow, entry: EntryRow, b: Record<string, unknown>): MeetState {
    only(b, ["weight", "mode", "place_id"]);
    const p = b as MeetMemberPut;
    const places = JSON.parse(entry.places) as Place[];
    if (!places.length || entry.deleted_at) throw new HttpError(400, "the entry has no place");
    const members = store.meetMembers(map.id);
    const old = members.find((m) => m.entry_id === entry.id);
    if (!old && members.length >= config.meet.max_members)
      throw new HttpError(409, `Mehr als ${config.meet.max_members} Einträge gehen nicht in die Auswahl.`);
    const weight = p.weight === undefined ? (old?.weight ?? 1) : int(p.weight, "weight", 1);
    if (weight > 4) throw new HttpError(400, "weight must be 1 to 4");
    const mode: unknown = p.mode ?? old?.mode ?? "car";
    if (mode !== "car" && mode !== "train") throw new HttpError(400, "mode must be car or train");
    const place_id = p.place_id === undefined ? (old?.place_id ?? null) : p.place_id;
    if (place_id != null && !places.some((x) => x.id === place_id)) throw new HttpError(400, "unknown place");
    store.tx(() => {
      store.putMeetMember({
        map_id: map.id,
        entry_id: entry.id,
        weight,
        mode: mode as MeetMode,
        place_id,
        updated: nowIso(),
      });
      store.bumpMap(map.id);
    });
    return state(store.mapById(map.id) as MapRow);
  }

  function deleteMember(map: MapRow, entry: EntryRow): MeetState {
    store.tx(() => {
      store.deleteMeetMember(map.id, entry.id);
      store.bumpMap(map.id);
    });
    return state(store.mapById(map.id) as MapRow);
  }

  /** The ranking for the given times; `carAt(i, c)` and `trainAt(i, c)` answer for member i. */
  function rank(
    members: MeetBasis[],
    candidates: Station[],
    leg: (m: MeetBasis, i: number, c: Station) => Omit<MeetLeg, "entry_id">,
  ): MeetCandidate[] {
    return candidates
      .map((station) => {
        const { candidate: _, ...out } = station;
        const legs = members.map((m, i) => ({ entry_id: m.entry_id, ...leg(m, i, station) }));
        const weighted = legs.map((l, i) => ({ weight: (members[i] as MeetBasis).weight, minutes: l.minutes }));
        const known = legs.flatMap((l) => (l.minutes == null ? [] : [l.minutes]));
        return {
          station: out,
          score: score(weighted),
          mean_min: meanMinutes(weighted),
          max_min: known.length ? Math.max(...known) : 0,
          legs,
        };
      })
      .sort((a, b) => a.score - b.score);
  }

  async function run(job: MeetJob, members: MeetBasis[]): Promise<MeetResult> {
    const m = config.meet;
    const pool = inBox(
      stations.filter((s) => s.candidate),
      members,
      BOX_KM,
    );
    const candidates = pool.length ? pool : stations.filter((s) => s.candidate);
    // A sea can lie between a place and its nearest station, so far from one the car ride decides.
    const trainMembers = members.filter((x) => x.mode === "train");
    const near = new Map(trainMembers.map((x) => [x.entry_id, closest(x, stations, HOME_CHOICES)]));
    const destinations = [...new Set([...candidates, ...[...near.values()].flat()])];
    const matrix = await travel.carMatrix(members, destinations);
    const car = (i: number, s: Station) => matrix[i]?.[destinations.indexOf(s)] ?? null;
    const home = new Map(
      trainMembers.map((x) => {
        const list = near.get(x.entry_id) as Station[];
        const first = list[0] as Station;
        if (kmBetween(x, first) <= m.station_radius_km) return [x.entry_id, first];
        const i = members.indexOf(x);
        const rides = list.filter((s) => car(i, s) != null);
        return [
          x.entry_id,
          rides.reduce((a, b) => ((car(i, b) as number) < (car(i, a) as number) ? b : a), rides[0] ?? first),
        ];
      }),
    );

    // Train times only for the places that look good by car, and the one nearest the middle.
    const byCar = rank(members, candidates, (_, i, c) => ({
      minutes: car(i, c),
      by: "car",
      station: null,
      access_min: 0,
    }));
    const keep = new Set(byCar.slice(0, m.train_candidates).map((c) => c.station.eva));
    const middle = weightedMiddle(members);
    if (middle) keep.add(nearest(middle, candidates).eva);
    const kept = candidates.filter((c) => keep.has(c.eva));

    const departure = isoInZone(nextDeparture(now(), m.departure_weekday, m.departure_hour), "Europe/Berlin");
    const pairs = [...new Set(home.values())].flatMap((from) =>
      kept.filter((to) => to.eva !== from.eva).map((to) => ({ from, to })),
    );
    job.total = pairs.filter((p) => !travel.trainCached(p.from.eva, p.to.eva)).length;
    const train = new Map<string, number | null>();
    let trainOk = true;
    for (const { from, to } of pairs) {
      const cached = travel.trainCached(from.eva, to.eva);
      try {
        train.set(`${from.eva}>${to.eva}`, await travel.trainMinutes(from.eva, to.eva, departure));
      } catch (e) {
        if (!(e instanceof TravelError)) throw e;
        console.error(`meeting point: ${e.message}`);
        trainOk = false;
        break;
      }
      if (!cached) job.done++;
    }

    const radius = m.station_radius_km;
    const ranked = rank(members, kept, (x, i, c) => {
      const byCarLeg = (by: "car" | "car-fallback") => ({ minutes: car(i, c), by, station: null, access_min: 0 });
      if (x.mode === "car") return byCarLeg("car");
      const from = home.get(x.entry_id) as Station;
      const access = kmBetween(x, from) <= radius ? 0 : car(i, from);
      const ride = from.eva === c.eva ? 0 : train.get(`${from.eva}>${c.eva}`);
      if (!trainOk || access == null || ride == null) return byCarLeg("car-fallback");
      return { minutes: access + ride, by: "train", station: from.name, access_min: access };
    });

    const notes: string[] = [];
    if (!trainOk) notes.push("Bahn-API nicht erreichbar – alle per Auto gerechnet.");
    for (const x of members) {
      const from = home.get(x.entry_id);
      if (!from || !trainOk) continue;
      const km = Math.round(kmBetween(x, from));
      if (km > FAR_HOME_KM) {
        const i = members.indexOf(x);
        const access = car(i, from);
        const way = access == null ? "" : `, ${hours(access)} Anfahrt mit dem Auto gerechnet`;
        notes.push(`${x.name}: ${km} km bis zum Fernbahnhof ${from.name}${way}.`);
      }
    }
    return {
      computed_at: nowIso(),
      departure,
      based_on: members,
      candidates: ranked.slice(0, TOP),
      train_ok: trainOk,
      notes,
    };
  }

  function compute(map: MapRow): MeetState {
    if (jobs.get(map.id)?.error === null) throw new HttpError(409, "Die Berechnung läuft schon.");
    const members = resolved(map.id);
    if (members.length < 2) throw new HttpError(400, "the selection needs two members");
    const job: MeetJob = { started: nowIso(), done: 0, total: 0, error: null };
    jobs.set(map.id, job);
    store.bumpMap(map.id);
    const hash = inputsHash(members);
    run(job, members)
      .then((result) => {
        if (!store.mapById(map.id)) return;
        store.tx(() => {
          store.putMeetResult(map.id, hash, JSON.stringify(result));
          jobs.delete(map.id);
          store.bumpMap(map.id);
        });
      })
      .catch((e) => {
        console.error("meeting point job failed:", e);
        job.error = "Die Fahrzeiten ließen sich gerade nicht holen. Bitte später nochmal.";
        if (store.mapById(map.id)) store.bumpMap(map.id);
      });
    return state(store.mapById(map.id) as MapRow);
  }

  return { state, putMember, deleteMember, compute };
}
