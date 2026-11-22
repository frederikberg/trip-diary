// A sample map with invented people and addresses: clusters in two cities, an entry with two places,
// one without a place, a long name, an emoji. The fake geocoder answers for these streets.
import type { EntryCreate, MapCreated } from "../src/shared/api";
import type { FakeGeoPlace, TestApp } from "../test/helpers";

export const LONG_NAME = "Maximiliane-Theresa von Hohenzollern-Sigmaringen & Bartholomäus";

const at = (address: string, lat: number, lon: number, label = "Zuhause") => ({ label, address, lat, lon });

export const SAMPLE_ENTRIES: EntryCreate[] = [
  {
    name: "Anna & Ben",
    note: "Klingel unten links.\nHund heißt Bruno.",
    places: [
      at("Lindenstraße 4, 40213 Düsseldorf", 51.225, 6.775),
      at("Hafenweg 12, 44147 Dortmund", 51.49, 7.45, "Arbeit"),
    ],
  },
  { name: "Lena", places: [at("Frankenstraße 8, 90402 Nürnberg", 49.45, 11.08)] },
  { name: "Tom & Vera", emoji: "🦊", places: [at("Musterweg 7, 30163 Hannover", 52.36, 9.755)] },
  { name: "Sina & Felix", places: [at("Am Kanal 3, 30165 Hannover", 52.385, 9.755)] },
  { name: "Theo", places: [at("Birkenallee 21, 30167 Hannover", 52.395, 9.757)] },
  { name: "Mira & Karl", places: [at("Gartenstraße 2, 30161 Hannover", 52.388, 9.745)] },
  { name: LONG_NAME, places: [at("Deichweg 1, 28195 Bremen", 53.075, 8.81)] },
  { name: "Clara & Daniel", places: [at("Isarstraße 15, 80469 München", 48.155, 11.52)] },
  { name: "Katrin", places: [at("Leopoldstraße 90, 80802 München", 48.183, 11.57)] },
  { name: "Gustav", note: "Zieht bald um." },
  { name: "Ida", places: [at("Oranienstraße 40, 10999 Berlin", 52.5, 13.42)] },
  { name: "Jonas & Rike", places: [at("Prenzlauer Allee 9, 10405 Berlin", 52.535, 13.42)] },
  { name: "Paula", places: [at("Venloer Straße 5, 50672 Köln", 50.942, 6.93)] },
  { name: "Quirin", places: [at("Karl-Liebknecht-Straße 11, 04107 Leipzig", 51.32, 12.37)] },
  { name: "Rosa & Ulf", places: [at("Elbchaussee 3, 22765 Hamburg", 53.545, 9.93)] },
  { name: "Wanda", places: [at("Königstraße 20, 70173 Stuttgart", 48.778, 9.178)] },
  { name: "Yusuf", places: [at("Zeil 10, 60313 Frankfurt am Main", 50.114, 8.68)] },
];

export const SAMPLE_GEO: FakeGeoPlace[] = [
  {
    match: "Beispielallee",
    lat: 52.3812,
    lon: 9.7437,
    street: "Beispielallee",
    housenumber: "33",
    postcode: "30161",
    city: "Hannover",
    country: "Deutschland",
  },
  {
    match: "Beispieldamm",
    lat: 52.3899,
    lon: 9.7512,
    street: "Beispieldamm",
    housenumber: "5",
    postcode: "30163",
    city: "Hannover",
    country: "Deutschland",
  },
  {
    match: "Bahnhofstraße",
    lat: 47.378,
    lon: 8.54,
    street: "Bahnhofstrasse",
    housenumber: "1",
    postcode: "8001",
    city: "Zürich",
    country: "Schweiz",
  },
];

/** Creates the sample map; returns its two links' tokens. */
export async function addSampleMap(app: TestApp): Promise<{ view: string; edit: string }> {
  const res = await app.call("/api/admin/maps", {
    method: "POST",
    admin: true,
    json: { slug: "freunde", title: "Unsere Leute" },
  });
  if (res.status !== 201) throw new Error(`create map: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as MapCreated;
  for (const e of SAMPLE_ENTRIES) {
    const r = await app.call("/api/admin/maps/freunde/entries", { method: "POST", admin: true, json: e });
    if (r.status !== 201) throw new Error(`entry ${e.name}: ${r.status} ${await r.text()}`);
  }
  return { view: created.view.token, edit: created.edit.token };
}
