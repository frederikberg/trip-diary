// The Leaflet map: topo tiles, the day tracks, passed waypoints and the note pins.
import * as L from "leaflet";
import type { Note, TripView, Waypoint } from "../src/shared/api";
import { dayColour, esc, icon } from "./util";

/** Below this zoom waypoints hide and pins shrink, so the tracks stay readable. */
const NEAR_ZOOM = 13;
const SMALL_PIN_ZOOM = 12;

const POI: Record<string, { colour: string; shape: "circle" | "square" | "diamond"; glyph: string }> = {
  spring: { colour: "#1e88e5", shape: "circle", glyph: "Q" },
  tap: { colour: "#0d47a1", shape: "circle", glyph: "T" },
  toilet: { colour: "#5c6bc0", shape: "square", glyph: "WC" },
  stream: { colour: "#00acc1", shape: "diamond", glyph: "~" },
  cemetery: { colour: "#455a64", shape: "square", glyph: "+" },
  shop: { colour: "#fb8c00", shape: "square", glyph: "€" },
  shelter: { colour: "#6d4c41", shape: "circle", glyph: "U" },
  water: { colour: "#1e88e5", shape: "circle", glyph: "W" },
  other: { colour: "#616161", shape: "circle", glyph: "•" },
};

/** A generic water point is drawn as what its name says it is. */
function poiStyle(w: Waypoint) {
  if (w.kind !== "water") return POI[w.kind] ?? POI.other;
  if (/bach|stream/i.test(w.name)) return POI.stream;
  if (/quelle|brunnen|spring/i.test(w.name)) return POI.spring;
  if (/friedhof|cemetery/i.test(w.name)) return POI.cemetery;
  return POI.water;
}

export interface MapView {
  map: L.Map;
  render(view: TripView): void;
  select(key: string | null, day: number | null): void;
  fitAll(padTop: number, padRight?: number, padBottom?: number): void;
  onPin(fn: (key: string) => void): void;
  onTap(fn: (at: L.LatLng) => void): void;
  setPlacing(on: boolean): void;
  showMe(at: L.LatLng, accuracy: number): void;
  /** Placements waiting on the device for the network; one without a place draws nothing. */
  setPending(list: { lat: number | null; lon: number | null }[]): void;
  /** Each pin's own point on screen (for the self-test). */
  pinPoints(): { key: string; x: number; y: number }[];
}

export function createMap(el: HTMLElement): MapView {
  const map = L.map(el, { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }).addTo(map);
  if (!matchMedia("(pointer: coarse)").matches) L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);

  const tracks = L.layerGroup().addTo(map);
  const pois = L.layerGroup().addTo(map);
  const pinsLayer = L.layerGroup().addTo(map);
  const pendingLayer = L.layerGroup().addTo(map);
  const lines = new Map<number, L.FeatureGroup>();
  /** The stretches between a day's recordings: not ridden, drawn thin and dashed. */
  const gaps = new Map<number, L.Polyline[]>();
  const pins = new Map<string, { marker: L.Marker; note: Note }>();
  let selected: string | null = null;
  let selectedDay: number | null = null;
  let pinFn: (key: string) => void = () => {};
  let tapFn: (at: L.LatLng) => void = () => {};
  let bounds: L.LatLngBounds | null = null;
  let me: L.CircleMarker | null = null;
  let meRing: L.Circle | null = null;

  const pinIcon = (n: Note, sel: boolean) =>
    n.kind === "day"
      ? L.divIcon({
          className: "pin-wrap",
          iconSize: [30, 30],
          iconAnchor: [15, 15],
          html: `<div class="flag${sel ? " sel" : ""}" data-pin="${n.key}" style="--day:${dayColour(n.day)}">${icon.flag}<b>${n.day}</b></div>`,
        })
      : L.divIcon({
          className: "pin-wrap",
          iconSize: [32, 40],
          iconAnchor: [16, 36],
          html: `<div class="pin${sel ? " sel" : ""}${n.text || n.media.length ? "" : " empty"}" data-pin="${n.key}"><span>${n.number}</span></div>`,
        });

  const zIndex = (n: Note, sel: boolean) => (sel ? 5000 : n.kind === "day" ? 600 : 700);

  function styleLines() {
    for (const [day, line] of lines) {
      for (const g of gaps.get(day) ?? [])
        g.setStyle({ opacity: selectedDay == null || day === selectedDay ? 0.9 : 0.5 });
      line.setStyle(
        selectedDay == null
          ? { opacity: 0.9, weight: 5 }
          : day === selectedDay
            ? { opacity: 1, weight: 6 }
            : { opacity: 0.5, weight: 4 },
      );
    }
  }

  function zoomClasses() {
    const z = map.getZoom();
    el.classList.toggle("far", z < NEAR_ZOOM);
    el.classList.toggle("small-pins", z < SMALL_PIN_ZOOM);
  }
  map.on("zoomend", zoomClasses);
  map.on("click", (e: L.LeafletMouseEvent) => tapFn(e.latlng));

  return {
    map,
    render(view) {
      tracks.clearLayers();
      lines.clear();
      gaps.clear();
      const all: L.LatLngExpression[] = [];
      for (const d of view.days) {
        if (!d.track.length) continue;
        const pts = d.track.map((p) => [p[0], p[1]] as L.LatLngTuple);
        all.push(...pts);
        const colour = dayColour(d.n);
        const cuts = [0, ...(d.breaks ?? []), pts.length];
        const line = L.featureGroup();
        const dashed: L.Polyline[] = [];
        for (let i = 1; i < cuts.length; i++) {
          const from = cuts[i - 1] as number;
          const to = cuts[i] as number;
          line.addLayer(
            L.polyline(pts.slice(from, to), { color: colour, weight: 5, opacity: 0.9, interactive: false }),
          );
          if (i > 1)
            dashed.push(
              L.polyline([pts[from - 1], pts[from]] as L.LatLngTuple[], {
                color: colour,
                weight: 2,
                opacity: 0.9,
                dashArray: "4 8",
                interactive: false,
              }).addTo(tracks),
            );
        }
        gaps.set(d.n, dashed);
        lines.set(d.n, line.addTo(tracks));
      }
      styleLines();
      pois.clearLayers();
      for (const w of view.waypoints) {
        const st = poiStyle(w) ?? (POI.other as NonNullable<ReturnType<typeof poiStyle>>);
        L.marker([w.lat, w.lon], {
          icon: L.divIcon({
            className: "poi-wrap",
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            html: `<div class="poi ${st.shape}" style="--c:${st.colour}"><i></i><span>${esc(st.glyph)}</span></div>`,
          }),
          zIndexOffset: 100,
        })
          .bindPopup(`<b>${esc(w.name)}</b>${w.notes ? `<br>${esc(w.notes)}` : ""}`, {
            closeButton: false,
            autoPanPadding: [40, 120],
          })
          .addTo(pois);
      }
      const seen = new Set<string>();
      for (const n of view.notes) {
        // A note without a place has no pin; selecting it highlights its day's track only.
        if (n.lat == null || n.lon == null) continue;
        const at: L.LatLngTuple = [n.lat, n.lon];
        seen.add(n.key);
        all.push(at);
        const sel = n.key === selected;
        const old = pins.get(n.key);
        if (old) {
          old.note = n;
          old.marker.setLatLng(at).setIcon(pinIcon(n, sel)).setZIndexOffset(zIndex(n, sel));
          continue;
        }
        const marker = L.marker(at, {
          icon: pinIcon(n, sel),
          zIndexOffset: zIndex(n, sel),
          keyboard: false,
        });
        marker.on("click", (e) => {
          L.DomEvent.stop(e);
          pinFn(n.key);
        });
        pins.set(n.key, { marker: marker.addTo(pinsLayer), note: n });
      }
      for (const [key, p] of pins)
        if (!seen.has(key)) {
          pinsLayer.removeLayer(p.marker);
          pins.delete(key);
        }
      bounds = all.length ? L.latLngBounds(all) : null;
      zoomClasses();
    },
    select(key, day) {
      const prev = selected;
      selected = key;
      selectedDay = day;
      for (const k of [prev, key]) {
        const p = k ? pins.get(k) : undefined;
        if (p) p.marker.setIcon(pinIcon(p.note, k === key)).setZIndexOffset(zIndex(p.note, k === key));
      }
      styleLines();
    },
    fitAll(padTop, padRight = 0, padBottom = 0) {
      if (bounds)
        map.fitBounds(bounds, {
          paddingTopLeft: [24, padTop + 20],
          paddingBottomRight: [24 + padRight, 28 + padBottom],
          animate: false,
        });
      else map.setView([50.5, 9.5], 6, { animate: false });
    },
    onPin(fn) {
      pinFn = fn;
    },
    onTap(fn) {
      tapFn = fn;
    },
    setPlacing(on) {
      el.classList.toggle("placing", on);
    },
    pinPoints() {
      return [...pins.entries()].map(([key, p]) => {
        const c = map.latLngToContainerPoint(p.marker.getLatLng());
        const r = el.getBoundingClientRect();
        return { key, x: c.x + r.left, y: c.y + r.top };
      });
    },
    setPending(list) {
      pendingLayer.clearLayers();
      for (const p of list) {
        if (p.lat == null || p.lon == null) continue;
        L.marker([p.lat, p.lon], {
          icon: L.divIcon({
            className: "pin-wrap",
            iconSize: [32, 40],
            iconAnchor: [16, 36],
            html: '<div class="pin pending"><span>…</span></div>',
          }),
          interactive: false,
          zIndexOffset: 4000,
        }).addTo(pendingLayer);
      }
    },
    showMe(at, accuracy) {
      if (!me) {
        meRing = L.circle(at, {
          radius: accuracy,
          color: "#2563eb",
          weight: 1,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(map);
        me = L.circleMarker(at, {
          radius: 7,
          color: "#fff",
          weight: 3,
          fillColor: "#2563eb",
          fillOpacity: 1,
          interactive: false,
        }).addTo(map);
      } else {
        me.setLatLng(at);
        meRing?.setLatLng(at).setRadius(accuracy);
      }
    },
  };
}
