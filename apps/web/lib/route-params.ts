/**
 * Guards for ids that arrive in a URL path.
 *
 * The web UI only ever links to ids it just read out of the database, so a
 * malformed one never came up. A native client can send anything, and Postgres
 * answers a bad uuid with `22P02 invalid input syntax`, which surfaces as a
 * raw 500. "Not found" is both the honest answer and the safe one — it doesn't
 * confirm whether a well-formed id exists.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string that is also a real calendar date. */
export function isIsoDate(value: string | undefined | null): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  // Rejects 2026-02-31 and friends, which match the pattern but aren't dates.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
