/**
 * UK-local (Europe/London) calendar-date helpers, shared by anything that needs
 * to scope a query to "today's traffic day" in UK local time — apps/web (Darwin
 * timing points) and services/nr-ingest (CIF schedule lookups) both do this.
 * Never rely on the host timezone.
 */

export interface UkParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const ukDtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Calendar/clock fields of an instant, as seen in Europe/London. */
export function ukParts(d: Date): UkParts {
  const p = Object.fromEntries(ukDtf.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    // en-GB with hour12:false renders midnight as "24" in some ICU versions.
    hour: Number(p.hour === "24" ? "00" : p.hour),
    month: Number(p.month),
    day: Number(p.day),
    minute: Number(p.minute),
  };
}

/** "YYYY-MM-DD" for the London calendar date of an instant. */
export function londonDateKey(d: Date = new Date()): string {
  const p = ukParts(d);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
