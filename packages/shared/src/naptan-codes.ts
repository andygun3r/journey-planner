/**
 * TfL location/line identifiers — a different code system from GB rail's
 * CRS/TIPLOC/NLC (see codes.ts). Kept in a separate file deliberately: these
 * are TfL-specific and should never be confused with or fall back to rail codes.
 * - NaPTAN/ATCO id: stop identifier, e.g. "9400ZZLUKSX1" (rail/tube/DLR/Overground/
 *   Elizabeth line stop) or "490000173N" (bus stop). Variable length, not fixed like CRS.
 * - TfL line id: lowercase-hyphenated, e.g. "victoria", "elizabeth", or a bus route
 *   number like "N1".
 */

const NAPTAN_RE = /^[0-9A-Za-z]{3,20}$/;
const TFL_LINE_ID_RE = /^[a-z0-9-]{1,20}$/i;

export const TFL_MODES = [
  "tube",
  "bus",
  "overground",
  "dlr",
  "elizabeth-line",
  "tram",
] as const;
export type TflMode = (typeof TFL_MODES)[number];

export function isNaptanId(value: string): boolean {
  return NAPTAN_RE.test(value);
}

export function isTflLineId(value: string): boolean {
  return TFL_LINE_ID_RE.test(value);
}

/**
 * Official TfL line colours, keyed by line id as the TfL API returns it.
 *
 * These are the colours people already read as "the tube map", so a route
 * drawn in them is legible before any label is read. Per-LINE, not per-mode:
 * Central is red and Victoria light blue, and collapsing both to one "tube"
 * colour throws away the strongest cue the map has.
 *
 * Source: TfL's published colour standard. Bus/tram take their mode colour,
 * since individual bus routes have no colour of their own.
 *
 * Colour is never the only cue — see the walk/transit dash treatment in
 * apps/web/components/journey-map-layer.tsx, and PRODUCT.md on WCAG 2.2 AA.
 */
const TFL_LINE_COLOURS: Record<string, string> = {
  bakerloo: "#B36305",
  central: "#E32017",
  circle: "#FFD300",
  district: "#00782A",
  "hammersmith-city": "#F3A9BB",
  jubilee: "#A0A5A9",
  metropolitan: "#9B0056",
  northern: "#000000",
  piccadilly: "#003688",
  victoria: "#0098D4",
  "waterloo-city": "#95CDBA",
  elizabeth: "#6950A1",
  dlr: "#00A4A7",
  tram: "#5FB526",
  // The Overground lines were renamed and individually coloured in 2024;
  // the legacy single "london-overground" id is kept for older responses.
  "london-overground": "#EE7C0E",
  liberty: "#5D6061",
  lioness: "#FFA600",
  mildmay: "#0077AD",
  suffragette: "#5BBD72",
  weaver: "#823A62",
  windrush: "#ED1B00",
  "thameslink*": "#E10A8D",
};

/** Fallback colour per mode, for lines with no colour of their own (buses). */
const TFL_MODE_COLOURS: Record<string, string> = {
  tube: "#0009A8",
  bus: "#E32017",
  overground: "#EE7C0E",
  dlr: "#00A4A7",
  "elizabeth-line": "#6950A1",
  tram: "#5FB526",
};

/**
 * Colour for a TfL leg. Prefers the specific line, falls back to the mode,
 * and returns null when neither is known so callers can pick their own
 * default rather than being handed a misleading colour.
 */
export function tflColour(lineId?: string, mode?: string): string | null {
  if (lineId) {
    const byLine = TFL_LINE_COLOURS[lineId.toLowerCase()];
    if (byLine) return byLine;
  }
  if (mode) {
    const byMode = TFL_MODE_COLOURS[mode.toLowerCase()];
    if (byMode) return byMode;
  }
  return null;
}