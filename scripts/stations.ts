#!/usr/bin/env bun
// Writes src/server/stations.json, the long-distance stations of the meeting point: names below →
// DB's location search → coordinates and EVA number. A name that does not resolve to a station with
// long-distance trains is left out and named at the end, and the run fails. Run by hand, one request per name, 1.1 s apart; the output is committed.
//   bun scripts/stations.ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const LOCATION = "application/x.db.vendo.mob.location.v3+json";
const LONG_DISTANCE = ["HOCHGESCHWINDIGKEITSZUEGE", "INTERCITYUNDEUROCITYZUEGE"];

/** Stations that can be a home station but are no meeting point: a city's second station. */
const HOME_ONLY = [
  "Berlin Gesundbrunnen",
  "Berlin Ostbahnhof",
  "Berlin Südkreuz",
  "Hamburg-Altona",
  "Kassel Hbf",
  "Köln Messe/Deutz",
  "München Ost",
];

const CANDIDATES = [
  "Aachen Hbf",
  "Augsburg Hbf",
  "Bamberg",
  "Berlin Hbf",
  "Bielefeld Hbf",
  "Bochum Hbf",
  "Bonn Hbf",
  "Braunschweig Hbf",
  "Bremen Hbf",
  "Chemnitz Hbf",
  "Cottbus Hbf",
  "Darmstadt Hbf",
  "Dortmund Hbf",
  "Dresden Hbf",
  "Duisburg Hbf",
  "Düsseldorf Hbf",
  "Eisenach",
  "Erfurt Hbf",
  "Essen Hbf",
  "Flensburg",
  "Frankfurt(Main)Hbf",
  "Frankfurt(Oder)",
  "Freiburg(Breisgau) Hbf",
  "Fulda",
  "Gießen",
  "Göttingen",
  "Greifswald",
  "Hagen Hbf",
  "Halle(Saale)Hbf",
  "Hamburg Hbf",
  "Hamm(Westf)Hbf",
  "Hannover Hbf",
  "Heidelberg Hbf",
  "Heilbronn Hbf",
  "Hildesheim Hbf",
  "Ingolstadt Hbf",
  "Jena Paradies",
  "Kaiserslautern Hbf",
  "Karlsruhe Hbf",
  "Kassel-Wilhelmshöhe",
  "Kempten(Allgäu)Hbf",
  "Kiel Hbf",
  "Koblenz Hbf",
  "Köln Hbf",
  "Konstanz",
  "Leipzig Hbf",
  "Lübeck Hbf",
  "Lüneburg",
  "Magdeburg Hbf",
  "Mainz Hbf",
  "Mannheim Hbf",
  "Mönchengladbach Hbf",
  "München Hbf",
  "Münster(Westf)Hbf",
  "Nürnberg Hbf",
  "Offenburg",
  "Oldenburg(Oldb)Hbf",
  "Osnabrück Hbf",
  "Paderborn Hbf",
  "Passau Hbf",
  "Potsdam Hbf",
  "Regensburg Hbf",
  "Rostock Hbf",
  "Saarbrücken Hbf",
  "Schwerin Hbf",
  "Siegen Hbf",
  "Stralsund Hbf",
  "Stuttgart Hbf",
  "Ulm Hbf",
  "Wiesbaden Hbf",
  "Wolfsburg Hbf",
  "Würzburg Hbf",
  "Wuppertal Hbf",
];

interface Location {
  name: string;
  evaNr?: string;
  coordinates?: { latitude: number; longitude: number };
  products?: string[];
}

async function find(name: string): Promise<Location> {
  const res = await fetch("https://app.services-bahn.de/mob/location/search", {
    method: "POST",
    headers: {
      "content-type": LOCATION,
      accept: LOCATION,
      "x-correlation-id": `${randomUUID()}_${randomUUID()}`,
      "accept-language": "de",
    },
    body: JSON.stringify({ locationTypes: ["ST"], searchTerm: name, maxResults: 1 }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const [hit] = (await res.json()) as Location[];
  if (!hit?.evaNr || !hit.coordinates) throw new Error(`${name}: no station`);
  if (!hit.products?.some((p) => LONG_DISTANCE.includes(p))) throw new Error(`${name}: no long-distance trains`);
  return hit;
}

const failed: string[] = [];
const out: { name: string; eva: string; lat: number; lon: number; candidate: boolean }[] = [];
for (const [names, candidate] of [
  [CANDIDATES, true],
  [HOME_ONLY, false],
] as const)
  for (const name of names) {
    await Bun.sleep(1100);
    const s = await find(name).catch((e: Error) => void failed.push(e.message));
    if (!s) continue;
    const { latitude: lat, longitude: lon } = s.coordinates as NonNullable<Location["coordinates"]>;
    out.push({ name: s.name, eva: s.evaNr as string, lat, lon, candidate });
  }

await Bun.write(join(import.meta.dir, "../src/server/stations.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`src/server/stations.json: ${out.length} stations`);
if (failed.length) {
  console.error(`take these out of the lists:\n${failed.join("\n")}`);
  process.exit(1);
}
