// The map: MapLibre with the page's own style, avatar pins, clusters, the blue dot, a temporary pin
// for an address and the pin that is dragged while a place moves.
import {
  AttributionControl,
  type GeoJSONSource,
  getVersion,
  LngLatBounds,
  Map as MapLibre,
  Marker,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import type { Entry, Place } from "../../src/shared/api";
import { centroid, cluster, fanOut } from "./cluster";
import style from "./style.json";
import { esc, faceHtml, PALETTE } from "./util";

/** Pins closer than this on screen, in pixels, become a cluster. */
const CLUSTER_RADIUS = 44;
/** Places this close, in metres, share a spot: their pins stand side by side instead of in a cluster. */
const SAME_SPOT_M = 15;
const FAN_GAP = 52;
/** More pins than this on one spot stay a cluster that opens as a list. */
const FAN_MAX = 6;
const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP = 10;
const CLICK_AFTER_PRESS_MS = 400;
const SINGLE_PLACE_ZOOM = 12;
const GERMANY: [[number, number], [number, number]] = [
  [5.6, 47.6],
  [13.2, 54.8],
];

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MapEvents {
  pin(entry: number, place: string): void;
  /** Places that stay together however far the map zooms. */
  group(entries: number[], at: { lat: number; lon: number }): void;
  tap(): void;
  /** A long press, or a right click. */
  hold(lat: number, lon: number): void;
  /** The part of the map nothing covers. */
  padding(): Padding;
  /** A star of the meeting point, by rank. */
  star(rank: number): void;
  /** The tiles or the style could not be loaded. */
  failed(): void;
}

interface Item {
  key: string;
  entry: Entry;
  place: Place;
}

/** What the meeting point draws. */
export interface MeetLayer {
  middle: { lat: number; lon: number } | null;
  /** Best first. */
  stars: { lat: number; lon: number; selected: boolean }[];
  /** From each member to the selected star. */
  lines: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; train: boolean }[];
  /** Entries in the selection; the others fade. */
  members: Set<number>;
}

export interface PeopleMap {
  /** False for the stand-in on a browser that cannot draw the map. */
  live: boolean;
  setMeet(layer: MeetLayer | null): void;
  center(): { lat: number; lon: number };
  zoom(): number;
  setEntries(entries: Entry[]): void;
  /** The selected entry's pins stay out of clusters. */
  select(entry: number | null): void;
  /** Shows every place, or Germany on an empty map. */
  fitAll(p: Padding, animate?: boolean): void;
  /** Brings the places into view. */
  show(places: { lat: number; lon: number }[], p: Padding): void;
  flyTo(lat: number, lon: number, zoom: number): void;
  /** Where the point is on screen. */
  point(lat: number, lon: number): { x: number; y: number };
  setTemp(at: { lat: number; lon: number } | null): void;
  setMe(at: { lat: number; lon: number }): void;
  /** Hides the other pins and puts a draggable pin at `at`; a tap on the map moves it there too. */
  startMove(at: { lat: number; lon: number }): void;
  /** Ends moving; returns where the pin is. */
  stopMove(): { lat: number; lon: number };
  /** The visible markers, for the browser test. */
  markers(): { key: string; x: number; y: number }[];
  /** The MapLibre map, for the browser test. */
  debug(): MapLibre | null;
}

/** Stands in where the map cannot start, so the list works without it. */
export function noMap(): PeopleMap {
  const off = { x: -1, y: -1 };
  return {
    live: false,
    setMeet() {},
    center: () => ({ lat: 0, lon: 0 }),
    zoom: () => 0,
    setEntries() {},
    select() {},
    fitAll() {},
    show() {},
    flyTo() {},
    point: () => off,
    setTemp() {},
    setMe() {},
    startMove() {},
    stopMove: () => ({ lat: 0, lon: 0 }),
    markers: () => [],
    debug: () => null,
  };
}

export function createMap(el: HTMLElement, on: MapEvents): PeopleMap {
  if (!document.createElement("canvas").getContext("webgl2")) throw new Error("no WebGL 2");
  setWorkerUrl(`/assets/maplibre-gl-worker.mjs?v=${getVersion()}`);
  const map = new MapLibre({
    container: el,
    style: style as unknown as StyleSpecification,
    attributionControl: false,
    maxZoom: 18,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    bounds: GERMANY,
  });
  map.addControl(new AttributionControl({ compact: true }), "bottom-left");
  // The compact control starts open, across the pins; its button opens it.
  map.once("load", () => el.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show"));
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  let items: Item[] = [];
  /** Pins sharing a spot with others: which spot, and how far they stand from it. */
  let fan = new Map<string, { spot: number; dx: number }>();
  let selected: number | null = null;
  let moving: Marker | null = null;
  let temp: Marker | null = null;
  let me: Marker | null = null;
  const shown = new Map<string, Marker>();
  let meet: MeetLayer | null = null;
  let meetMarkers: Marker[] = [];
  let lineData: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  map.once("load", () => {
    map.addSource("meet", { type: "geojson", data: lineData });
    const first = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    const layer = (id: string, train: boolean, dash?: number[]) =>
      map.addLayer(
        {
          id,
          type: "line",
          source: "meet",
          filter: ["==", ["get", "train"], train],
          paint: {
            "line-color": "#c2410c",
            "line-width": 2,
            "line-opacity": 0.75,
            ...(dash ? { "line-dasharray": dash } : {}),
          },
        },
        first,
      );
    layer("meet-car", false);
    layer("meet-train", true, [2, 2]);
  });

  function pinElement(it: Item): HTMLElement {
    const e = document.createElement("div");
    e.className = fan.has(it.key) ? "pin fan" : "pin";
    e.dataset.entry = String(it.entry.id);
    e.style.background = PALETTE[it.entry.color % PALETTE.length] as string;
    e.innerHTML = `<span class="f${it.entry.emoji ? " emoji" : ""}">${faceHtml(it.entry)}</span><span class="n">${esc(it.entry.name)}</span>`;
    e.addEventListener("click", (ev) => {
      ev.stopPropagation();
      on.pin(it.entry.id, it.place.id);
    });
    return e;
  }

  function clusterElement(group: Item[]): HTMLElement {
    const e = document.createElement("div");
    e.className = "cluster";
    e.textContent = String(group.length);
    e.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openCluster(group);
    });
    return e;
  }

  /** Zooms to the group; a group that zooming cannot take apart opens as a list. */
  function openCluster(group: Item[]) {
    const b = new LngLatBounds();
    for (const it of group) b.extend([it.place.lon, it.place.lat]);
    const p = pinPadding(on.padding());
    const cam = map.cameraForBounds(b, { padding: p, maxZoom: map.getMaxZoom() });
    if (!cam?.zoom || cam.zoom < map.getZoom() + 0.5 || map.getZoom() >= 16)
      return on.group([...new Set(group.map((it) => it.entry.id))], centroid(group.map((it) => it.place)));
    map.fitBounds(b, { padding: p, duration: 450 });
  }

  function draw() {
    const wanted = new Map<
      string,
      { at: { lat: number; lon: number }; make: () => HTMLElement; anchorPin: boolean; dx?: number }
    >();
    const single = (it: Item) => {
      const dx = fan.get(it.key)?.dx ?? 0;
      wanted.set(`p:${it.key}:${it.entry.rev}:${dx}`, {
        at: it.place,
        make: () => pinElement(it),
        anchorPin: true,
        dx,
      });
    };
    if (!moving) {
      const free = items.filter((it) => it.entry.id !== selected);
      for (const it of items) if (it.entry.id === selected) single(it);
      const byKey = new Map(free.map((it) => [it.key, it]));
      const points = free.map((it) => {
        const p = map.project([it.place.lon, it.place.lat]);
        return { key: it.key, x: p.x, y: p.y };
      });
      for (const keys of cluster(points, CLUSTER_RADIUS)) {
        const group = keys.map((k) => byKey.get(k) as Item);
        const spot = fan.get(group[0]?.key ?? "")?.spot;
        if (group.length === 1 || (spot !== undefined && group.every((it) => fan.get(it.key)?.spot === spot)))
          for (const it of group) single(it);
        else {
          const revs = group.reduce((s, it) => s + it.entry.rev, 0);
          wanted.set(`c:${keys.join(",")}:${revs}`, {
            at: centroid(group.map((it) => it.place)),
            make: () => clusterElement(group),
            anchorPin: false,
          });
        }
      }
    }
    for (const [k, m] of shown)
      if (!wanted.has(k)) {
        m.remove();
        shown.delete(k);
      }
    for (const [k, w] of wanted)
      if (!shown.has(k)) {
        const m = new Marker(
          w.anchorPin
            ? { element: w.make(), anchor: "bottom", offset: [w.dx ?? 0, 8] }
            : { element: w.make(), anchor: "center" },
        )
          .setLngLat([w.at.lon, w.at.lat])
          .addTo(map);
        shown.set(k, m);
      }
    for (const [k, m] of shown) {
      m.getElement().classList.toggle("sel", k.startsWith(`p:${selected}:`));
      const id = Number(m.getElement().dataset.entry);
      m.getElement().classList.toggle("dim", meet != null && !!id && !meet.members.has(id));
    }
  }

  // A long press on the map. iOS sends no contextmenu, so it is timed here; Android's contextmenu
  // may come first. The click some browsers send on release belongs to the press.
  let press: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let touching = false;
  let swallowClick = false;
  const held = (lat: number, lon: number) => {
    cancelPress();
    swallowClick = touching;
    on.hold(lat, lon);
  };
  const cancelPress = () => {
    clearTimeout(press);
    start = null;
  };
  map.on("touchstart", (e) => {
    cancelPress();
    touching = true;
    swallowClick = false;
    if (moving || e.originalEvent.touches.length !== 1) return;
    start = e.point;
    press = setTimeout(() => held(e.lngLat.lat, e.lngLat.lng), LONG_PRESS_MS);
  });
  map.on("touchmove", (e) => {
    if (start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > LONG_PRESS_SLOP) cancelPress();
  });
  const released = () => {
    cancelPress();
    touching = false;
    if (swallowClick) setTimeout(() => (swallowClick = false), CLICK_AFTER_PRESS_MS);
  };
  map.on("touchend", released);
  map.on("touchcancel", released);
  map.on("movestart", cancelPress);
  map.on("contextmenu", (e) => {
    if (!moving && !swallowClick) held(e.lngLat.lat, e.lngLat.lng);
  });

  map.on("click", (e) => {
    if (moving) moving.setLngLat(e.lngLat);
    else if (!swallowClick) on.tap();
  });
  map.on("moveend", draw);
  map.on("error", on.failed);

  /** Room for a pin's head above its point and its name below. */
  const pinPadding = (p: Padding) => ({ ...p, top: p.top + 48, bottom: p.bottom + 32, left: p.left + 24 });
  /** From the map's middle to the middle of the free part. Camera `padding` would stick to the map. */
  const offset = (p: Padding): [number, number] => [(p.left - p.right) / 2, (p.top - p.bottom) / 2];

  const small = (
    cls: string,
    at: { lat: number; lon: number },
    draggable = false,
    anchor: "center" | "bottom" = "center",
  ) => {
    const e = document.createElement("div");
    e.className = cls;
    return new Marker({ element: e, anchor, draggable }).setLngLat([at.lon, at.lat]).addTo(map);
  };

  return {
    live: true,
    setMeet(layer) {
      meet = layer;
      for (const m of meetMarkers) m.remove();
      meetMarkers = [];
      const features = (layer?.lines ?? []).map((l) => ({
        type: "Feature" as const,
        properties: { train: l.train },
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [l.from.lon, l.from.lat],
            [l.to.lon, l.to.lat],
          ],
        },
      }));
      lineData = { type: "FeatureCollection", features };
      const source = map.getSource("meet") as GeoJSONSource | undefined;
      source?.setData(lineData);
      if (layer?.middle) meetMarkers.push(small("meet-middle", layer.middle));
      layer?.stars.forEach((s, i) => {
        const m = small(`meet-star${s.selected ? " sel" : ""}`, s);
        m.getElement().textContent = `${i + 1}`;
        m.getElement().addEventListener("click", (ev) => {
          ev.stopPropagation();
          on.star(i);
        });
        meetMarkers.push(m);
      });
      draw();
    },
    center() {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },
    zoom: () => map.getZoom(),
    debug: () => map,
    setEntries(entries) {
      items = entries.flatMap((entry) =>
        entry.places.map((place) => ({ key: `${entry.id}:${place.id}`, entry, place })),
      );
      fan = fanOut(
        items.map((it) => ({ key: it.key, lat: it.place.lat, lon: it.place.lon })),
        SAME_SPOT_M,
        FAN_GAP,
        FAN_MAX,
      );
      draw();
    },
    select(entry) {
      selected = entry;
      draw();
    },
    fitAll(p, animate = false) {
      const b = new LngLatBounds();
      for (const it of items) b.extend([it.place.lon, it.place.lat]);
      const duration = animate ? 450 : 0;
      if (b.isEmpty()) map.fitBounds(GERMANY, { padding: p, duration });
      else map.fitBounds(b, { padding: pinPadding(p), maxZoom: SINGLE_PLACE_ZOOM, duration });
    },
    show(places, p) {
      const first = places[0];
      if (!first) return;
      if (places.length === 1) {
        map.easeTo({ center: [first.lon, first.lat], offset: offset(p), duration: 350 });
        return;
      }
      const b = new LngLatBounds();
      for (const x of places) b.extend([x.lon, x.lat]);
      map.fitBounds(b, { padding: pinPadding(p), maxZoom: Math.max(map.getZoom(), SINGLE_PLACE_ZOOM), duration: 450 });
    },
    flyTo(lat, lon, zoom) {
      map.flyTo({ center: [lon, lat], zoom, duration: 700, offset: offset(on.padding()) });
    },
    point(lat, lon) {
      const p = map.project([lon, lat]);
      return { x: p.x, y: p.y };
    },
    setTemp(at) {
      temp?.remove();
      temp = at ? small("temp-pin", at, false, "bottom") : null;
    },
    setMe(at) {
      if (me) me.setLngLat([at.lon, at.lat]);
      else me = small("me-dot", at);
    },
    startMove(at) {
      moving = small("temp-pin moving", at, true, "bottom");
      draw();
    },
    stopMove() {
      const c = (moving as Marker).getLngLat();
      moving?.remove();
      moving = null;
      draw();
      return { lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lng * 1e6) / 1e6 };
    },
    markers() {
      const all = [...shown.entries(), ...(moving ? ([["moving", moving]] as [string, Marker][]) : [])];
      return all.map(([key, m]) => {
        const r = m.getElement().getBoundingClientRect();
        return { key, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    },
  };
}
