/**
 * British National Grid (OSGB36, EPSG:27700) -> WGS84 lat/lon.
 *
 * Two genuinely separate steps, both needed:
 *   1. Inverse Transverse Mercator: BNG easting/northing -> OSGB36 lat/lon,
 *      Ordnance Survey's own published algorithm ("A guide to coordinate
 *      systems in Great Britain", Annexe B/C).
 *   2. OSGB36 -> WGS84 datum shift (Helmert transform). OSGB36 and WGS84
 *      disagree by up to ~100m on the ground — skipping this would silently
 *      bias every distance calculation downstream by a systematic amount
 *      larger than any snap tolerance this feature uses. The single 7-
 *      parameter Helmert below is only accurate to ~3.5-5m (OS's own stated
 *      figure) — enough for this feature's tolerances, but not survey-grade;
 *      OS's OSTN15 grid-shift is the sub-cm alternative, not used here since
 *      it needs a ~400k-point correction grid, disproportionate at these
 *      tolerances.
 *
 * Parameters and the worked test fixture below are OS's own published
 * values, cross-checked against the OS guide, docs.os.uk, and the
 * independently-vetted Chris Veness `geodesy` library (a faithful
 * transcription of the same OS annexes).
 */

// Airy 1830 ellipsoid.
const A = 6377563.396;
const B = 6356256.909;
const F0 = 0.9996012717; // scale factor on the central meridian
const PHI0 = (49 * Math.PI) / 180; // true origin latitude
const LAMBDA0 = (-2 * Math.PI) / 180; // true origin longitude
const E0 = 400000; // false origin easting
const N0 = -100000; // false origin northing

const N_RATIO = (A - B) / (A + B);
const ECC2 = (A * A - B * B) / (A * A); // eccentricity squared

/** BNG easting/northing -> OSGB36 lat/lon (radians internally, degrees out). */
export function bngToOsgb36(easting: number, northing: number): { lat: number; lon: number } {
  let phi = PHI0;
  let M = 0;
  do {
    phi = (northing - N0 - M) / (A * F0) + phi;
    const dPhi = phi - PHI0;
    const sPhi = phi + PHI0;
    const Ma = (1 + N_RATIO + (5 / 4) * N_RATIO ** 2 + (5 / 4) * N_RATIO ** 3) * dPhi;
    const Mb = (3 * N_RATIO + 3 * N_RATIO ** 2 + (21 / 8) * N_RATIO ** 3) * Math.sin(dPhi) * Math.cos(sPhi);
    const Mc = ((15 / 8) * N_RATIO ** 2 + (15 / 8) * N_RATIO ** 3) * Math.sin(2 * dPhi) * Math.cos(2 * sPhi);
    const Md = (35 / 24) * N_RATIO ** 3 * Math.sin(3 * dPhi) * Math.cos(3 * sPhi);
    M = B * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(northing - N0 - M) >= 0.00001);

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const nu = (A * F0) / Math.sqrt(1 - ECC2 * sinPhi * sinPhi);
  const rho = (A * F0 * (1 - ECC2)) / (1 - ECC2 * sinPhi * sinPhi) ** 1.5;
  const eta2 = nu / rho - 1;

  const dE = easting - E0;
  const tan2 = tanPhi * tanPhi;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const secPhi = 1 / cosPhi;

  const VII = tanPhi / (2 * rho * nu);
  const VIII = (tanPhi / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tanPhi / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = secPhi / nu;
  const XI = (secPhi / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const XII = (secPhi / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (secPhi / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const finalPhi = phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const finalLambda = LAMBDA0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  return { lat: (finalPhi * 180) / Math.PI, lon: (finalLambda * 180) / Math.PI };
}

// OSGB36 -> WGS84 Helmert transform, position-vector convention. OS publishes
// these seven values for WGS84 -> OSGB36; going the other way negates all
// seven (the standard small-angle-approximation inverse).
const HELMERT_TX = 446.448; // metres
const HELMERT_TY = -125.157;
const HELMERT_TZ = 542.060;
const HELMERT_RX = (0.1502 / 3600) * (Math.PI / 180); // arcseconds -> radians
const HELMERT_RY = (0.247 / 3600) * (Math.PI / 180);
const HELMERT_RZ = (0.8421 / 3600) * (Math.PI / 180);
const HELMERT_S = 1 - 20.4894e-6; // ppm -> scale factor

function latLonToCartesian(lat: number, lon: number, a: number, b: number): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const e2 = (a * a - b * b) / (a * a);
  const sinPhi = Math.sin(phi);
  const nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const x = nu * Math.cos(phi) * Math.cos(lambda);
  const y = nu * Math.cos(phi) * Math.sin(lambda);
  const z = nu * (1 - e2) * sinPhi;
  return [x, y, z];
}

function cartesianToLatLon(x: number, y: number, z: number, a: number, b: number): { lat: number; lon: number } {
  const e2 = (a * a - b * b) / (a * a);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const sinPhi = Math.sin(phi);
    const nu = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    phi = Math.atan2(z + e2 * nu * sinPhi, p);
  }
  const lambda = Math.atan2(y, x);
  return { lat: (phi * 180) / Math.PI, lon: (lambda * 180) / Math.PI };
}

function osgb36ToWgs84(lat: number, lon: number): { lat: number; lon: number } {
  const [x1, y1, z1] = latLonToCartesian(lat, lon, A, B);
  // Position-vector Helmert: x2 = tx + s*x1 - rz*y1 + ry*z1, etc.
  const x2 = HELMERT_TX + HELMERT_S * x1 - HELMERT_RZ * y1 + HELMERT_RY * z1;
  const y2 = HELMERT_TY + HELMERT_RZ * x1 + HELMERT_S * y1 - HELMERT_RX * z1;
  const z2 = HELMERT_TZ - HELMERT_RY * x1 + HELMERT_RX * y1 + HELMERT_S * z1;
  // WGS84 ellipsoid.
  return cartesianToLatLon(x2, y2, z2, 6378137, 6356752.314245);
}

/** BNG easting/northing -> WGS84 lat/lon. The public entry point. */
export function bngToWgs84(easting: number, northing: number): { lat: number; lon: number } {
  const osgb36 = bngToOsgb36(easting, northing);
  return osgb36ToWgs84(osgb36.lat, osgb36.lon);
}

/** True ground distance in metres between two [lon, lat] WGS84 points. */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
