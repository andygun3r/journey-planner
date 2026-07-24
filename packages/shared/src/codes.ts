/**
 * GB rail location code systems:
 * - CRS (Computer Reservation System): 3 letters, e.g. KGX. What passengers see.
 * - TIPLOC (Timing Point Location): <=7 alphanumerics, e.g. KNGX. Used by CIF/Darwin.
 * - NLC (National Location Code): 4 digits (+2 optional), used by fares data.
 * - RID (Darwin run id): unique per train run per day; pairs with (uid, ssd).
 */

const CRS_RE = /^[A-Z]{3}$/;
const TIPLOC_RE = /^[A-Z0-9]{1,7}$/;
const NLC_RE = /^[A-Z0-9]{4}$/;
const TRAIN_UID_RE = /^[A-Z]\d{5}$/;

export function isCrs(value: string): boolean {
  return CRS_RE.test(value);
}

export function normaliseCrs(value: string): string {
  const crs = value.trim().toUpperCase();
  if (!isCrs(crs)) throw new Error(`Invalid CRS code: ${value}`);
  return crs;
}

export function isTiploc(value: string): boolean {
  return TIPLOC_RE.test(value);
}

export function normaliseTiploc(value: string): string {
  const tiploc = value.trim().toUpperCase();
  if (!isTiploc(tiploc)) throw new Error(`Invalid TIPLOC: ${value}`);
  return tiploc;
}

export function isNlc(value: string): boolean {
  return NLC_RE.test(value);
}

export function isTrainUid(value: string): boolean {
  return TRAIN_UID_RE.test(value);
}

/**
 * Days-of-week bitmask used by commute schedules and trip_mapping.
 * Bit 0 = Monday ... bit 6 = Sunday (matches CIF days_run ordering).
 */
export function daysMaskFromCif(daysRun: string): number {
  if (!/^[01]{7}$/.test(daysRun)) throw new Error(`Invalid CIF days_run: ${daysRun}`);
  let mask = 0;
  for (let i = 0; i < 7; i++) {
    if (daysRun[i] === "1") mask |= 1 << i;
  }
  return mask;
}

export function daysMaskIncludes(mask: number, date: Date): boolean {
  // JS getDay(): 0 = Sunday; our bit 0 = Monday.
  const bit = (date.getDay() + 6) % 7;
  return (mask & (1 << bit)) !== 0;
}
