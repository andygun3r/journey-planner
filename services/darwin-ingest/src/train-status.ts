/**
 * Small HH:MM[:SS] delay-calc helpers shared by alerts.ts (live Kafka TS
 * updates) and pre-departure.ts (darwin_stop_forecast DB rows) — both carry
 * scheduled/estimated times in the same "HH:MM[:SS], UK local, same day"
 * shape, so one implementation covers both.
 */

/** Minutes from a scheduled HH:MM[:SS] to an estimated HH:MM[:SS] (same day). */
export function hhmmDeltaMinutes(sched: string, est: string): number | null {
  const s = toMinutes(sched);
  const e = toMinutes(est);
  if (s === null || e === null) return null;
  let delta = e - s;
  // Handle midnight wrap (est just after midnight, sched just before).
  if (delta < -720) delta += 1440;
  return delta;
}

export function toMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
