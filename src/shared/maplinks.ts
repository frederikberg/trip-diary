// Links out to Google Maps for a coordinate. These URL forms need no key.

const point = (lat: number, lon: number) => `${lat}%2C${lon}`;

export const googleMapsUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/search/?api=1&query=${point(lat, lon)}`;

export const googleRouteUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${point(lat, lon)}`;

export const streetViewUrl = (lat: number, lon: number) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${point(lat, lon)}`;
