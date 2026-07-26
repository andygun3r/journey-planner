/**
 * Equirectangular projection from WGS84 lat/lon to SVG coordinates, at GB's
 * mid-latitude, sharing one canvas box. The map looks like the UK; the geography
 * is the ~3,100 station coordinates.
 */

export type Projection = (lat: number, lon: number) => { x: number; y: number };

// GB bounding box (a little padding around the extremes of the network).
export const BOUNDS = { minLat: 49.9, maxLat: 58.75, minLon: -8.2, maxLon: 1.9 };
export const W = 1000;
// Height from an equirectangular aspect at GB's mid-latitude (~54°N).
const MID_LAT_RAD = ((BOUNDS.minLat + BOUNDS.maxLat) / 2) * (Math.PI / 180);
export const H = Math.round(
  (W * (BOUNDS.maxLat - BOUNDS.minLat)) / ((BOUNDS.maxLon - BOUNDS.minLon) * Math.cos(MID_LAT_RAD)),
);

export const projectGeographic: Projection = (lat, lon) => {
  const x = ((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * W;
  const y = ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * H;
  return { x, y };
};
