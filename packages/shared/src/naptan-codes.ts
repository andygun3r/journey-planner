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