#!/usr/bin/env bun
// Writes web/map/style.json, the base map of the map page: OpenFreeMap's positron restyled with
// German labels, warm paper land, soft water and borders that read at every zoom. Run by hand; the
// output is committed and bundled, so the page asks for no style file.
//   bun scripts/map-style.ts
import { join } from "node:path";

interface Layer {
  id: string;
  type: string;
  minzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

const SOURCE = "https://tiles.openfreemap.org/styles/positron";
const LABEL = ["coalesce", ["get", "name:de"], ["get", "name:latin"], ["get", "name"]];
const INK = "#1d2327";
const PAPER = "#f6f3ec";
const TOWN = "#3b3f43";
const BORDER = "#7a7064";
const CASING = "#d9d2c4";
const WATER = "#c6d9e5";

const zoom = (...stops: number[]) => ["interpolate", ["linear"], ["zoom"], ...stops];
const zoomExp = (...stops: number[]) => ["interpolate", ["exponential", 1.2], ["zoom"], ...stops];

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
const style = (await res.json()) as { layers: Layer[] };

function set(
  id: string,
  edit: (l: Layer & { layout: Record<string, unknown>; paint: Record<string, unknown> }) => void,
) {
  const l = style.layers.find((x) => x.id === id);
  if (!l) throw new Error(`positron has no layer ${id}`);
  l.layout ??= {};
  l.paint ??= {};
  edit(l as Parameters<typeof edit>[0]);
}

const fill = (id: string, colour: string) => set(id, (l) => (l.paint["fill-color"] = colour));
const line = (id: string, colour: unknown) => set(id, (l) => (l.paint["line-color"] = colour));

style.layers = style.layers.filter((l) => !/shield/.test(l.id));

for (const l of style.layers)
  if (l.type === "symbol" && l.layout?.["text-field"]) {
    l.layout["text-field"] = LABEL;
    l.paint = { ...l.paint, "text-halo-color": PAPER, "text-halo-width": 1.4, "text-halo-blur": 0.6 };
  }

set("background", (l) => (l.paint["background-color"] = PAPER));
fill("water", WATER);
line("waterway", WATER);
fill("park", "#e2e8d8");
fill("landuse_residential", "#eeeae1");
fill("landcover_wood", "#dfe5d3");
set("building", (l) => {
  l.paint["fill-color"] = "#e6e1d6";
  l.paint["fill-outline-color"] = "#ddd7cb";
});

line("highway_motorway_inner", ["interpolate", ["linear"], ["zoom"], 5.8, "rgba(0,0,0,0)", 6, "#ffffff"]);
line("highway_major_inner", "#ffffff");
line("highway_motorway_casing", CASING);
line("highway_major_casing", CASING);
line("highway_major_subtle", CASING);
line("highway_minor", "#e9e4da");
set("highway_motorway_subtle", (l) => {
  l.paint["line-color"] = CASING;
  l.paint["line-opacity"] = 0.6;
});

set("boundary_2", (l) => {
  l.paint["line-color"] = BORDER;
  l.paint["line-opacity"] = 1;
  l.paint["line-width"] = zoom(3, 1, 5, 1.6, 8, 2.2, 12, 3);
});
set("boundary_3", (l) => {
  l.minzoom = 4;
  l.paint["line-color"] = "#a9a093";
  l.paint["line-dasharray"] = [3, 2];
  l.paint["line-width"] = zoom(4, 0.6, 7, 1, 11, 1.6);
});
const border = style.layers.findIndex((l) => l.id === "boundary_2");
style.layers.splice(border, 0, {
  ...(style.layers[border] as Layer),
  id: "boundary_2_halo",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: { "line-color": BORDER, "line-opacity": 0.14, "line-width": zoom(3, 4, 6, 7, 12, 12) },
});

set("label_city", (l) => {
  l.paint["text-color"] = INK;
  l.layout["text-size"] = zoomExp(4, 12, 7, 14.5, 11, 19);
});
set("label_city_capital", (l) => {
  l.paint["text-color"] = INK;
  l.layout["text-font"] = ["Noto Sans Bold"];
  l.layout["text-size"] = zoomExp(4, 12.5, 7, 15.5, 11, 20);
});
for (const id of ["label_town", "label_village", "label_other"]) set(id, (l) => (l.paint["text-color"] = TOWN));
for (const id of ["label_country_1", "label_country_2", "label_country_3"])
  set(id, (l) => {
    l.paint["text-color"] = "#8a8070";
    l.layout["text-transform"] = "uppercase";
    l.layout["text-letter-spacing"] = 0.18;
    l.layout["text-size"] = zoom(1, 9, 4, 12, 6, 14, 8, 17);
  });
set("label_state", (l) => {
  l.paint["text-color"] = "#a39b8f";
  l.layout["text-letter-spacing"] = 0.14;
  l.layout["text-size"] = zoom(5, 10, 8, 13);
});

await Bun.write(join(import.meta.dir, "../web/map/style.json"), `${JSON.stringify(style)}\n`);
console.log(`web/map/style.json: ${style.layers.length} layers`);
