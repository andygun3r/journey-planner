/**
 * Parsing/encoding for journey search endpoints (the `from`/`to` query params
 * on /journeys). A plain CRS string works exactly as before; three new
 * prefixed forms cover GPS origins, geocoded postcodes, and explicit TfL
 * NaPTAN destinations — see the "on the move" search plan.
 */
import { isCrs, isNaptanId } from "@signaller/shared";

export type JourneyEndpoint =
  | { type: "crs"; crs: string }
  | { type: "naptan"; naptanId: string }
  | { type: "geo"; lat: number; lon: number }
  | { type: "postcode"; text: string }
  /** An OS Places UPRN — a free-text place/address search result. */
  | { type: "place"; uprn: string };

/** Parse a `from`/`to` query param value. Returns null if it's not a recognised shape. */
export function parseEndpoint(raw: string): JourneyEndpoint | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("geo:")) {
    const [latStr, lonStr] = value.slice(4).split(",");
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { type: "geo", lat, lon };
  }

  if (value.startsWith("postcode:")) {
    const text = value.slice("postcode:".length).trim();
    return text ? { type: "postcode", text } : null;
  }

  if (value.startsWith("place:")) {
    const uprn = value.slice("place:".length).trim();
    // UPRNs are numeric; anything else is a malformed or hand-edited URL.
    return /^\d+$/.test(uprn) ? { type: "place", uprn } : null;
  }

  if (value.startsWith("naptan:")) {
    const naptanId = value.slice("naptan:".length).trim();
    return naptanId ? { type: "naptan", naptanId } : null;
  }

  const upper = value.toUpperCase();
  if (isCrs(upper)) return { type: "crs", crs: upper };
  // Bare NaPTAN id with no prefix — planMultiModal's existing string API accepted
  // this shape directly; keep it working unprefixed too.
  if (isNaptanId(value) && !isCrs(upper)) return { type: "naptan", naptanId: value };

  return null;
}

export function encodeEndpoint(e: JourneyEndpoint): string {
  switch (e.type) {
    case "crs":
      return e.crs;
    case "naptan":
      return `naptan:${e.naptanId}`;
    case "geo":
      return `geo:${e.lat},${e.lon}`;
    case "postcode":
      return `postcode:${e.text}`;
    case "place":
      return `place:${e.uprn}`;
  }
}
