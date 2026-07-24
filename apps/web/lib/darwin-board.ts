import { darwinStopForecast, darwinTrain } from "@mainline/db";
import { and, eq, gte, lte } from "drizzle-orm";
import type { BoardDeparture } from "./board";
import { getDb } from "./db";

/**
 * Overlays live Darwin forecasts onto a scheduled board.
 *
 * Matching key: Darwin forecasts are stored per (rid, tiploc) with the
 * scheduled departure time. We match a scheduled board row to a Darwin stop
 * by (crs, scheduled departure minute). This is robust without needing the
 * trip_mapping join for the common case, and works the instant the ingester
 * starts writing rows. Until then, darwin_stop_forecast is empty and every
 * row passes through unchanged with hasLive=false.
 */

interface DarwinForecast {
  rid: string;
  schedDep: string | null; // HH:MM[:SS] UK local
  estDep: string | null;
  actDep: string | null;
  platform: string | null;
  platformChanged: boolean;
  suppressed: boolean;
  cancelled: boolean;
}

const ukHm = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

/** "HH:MM" (UK local) for an ISO instant. */
function ukHhmm(iso: string): string {
  return ukHm.format(new Date(iso));
}

/** Normalise Darwin "HH:MM[:SS]" to "HH:MM". */
function hhmm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

async function loadForecasts(crs: string): Promise<Map<string, DarwinForecast[]>> {
  const byTime = new Map<string, DarwinForecast[]>();
  let rows: Array<{
    rid: string;
    schedDep: string | null;
    estDep: string | null;
    actDep: string | null;
    platform: string | null;
    platformChanged: boolean;
    suppressed: boolean;
    cancelled: boolean;
  }>;
  try {
    rows = await getDb()
      .select({
        rid: darwinStopForecast.rid,
        schedDep: darwinStopForecast.schedDep,
        estDep: darwinStopForecast.estDep,
        actDep: darwinStopForecast.actDep,
        platform: darwinStopForecast.platform,
        platformChanged: darwinStopForecast.platformChanged,
        suppressed: darwinStopForecast.suppressed,
        cancelled: darwinTrain.cancelled,
      })
      .from(darwinStopForecast)
      .innerJoin(darwinTrain, eq(darwinStopForecast.rid, darwinTrain.rid))
      .where(eq(darwinStopForecast.crs, crs));
  } catch {
    return byTime; // table/DB not ready — treat as no live data
  }

  for (const r of rows) {
    const key = hhmm(r.schedDep);
    if (!key) continue;
    const list = byTime.get(key) ?? [];
    list.push({
      rid: r.rid,
      schedDep: r.schedDep,
      estDep: r.estDep,
      actDep: r.actDep,
      platform: r.platform,
      platformChanged: r.platformChanged,
      suppressed: r.suppressed,
      cancelled: r.cancelled,
    });
    byTime.set(key, list);
  }
  return byTime;
}

/** Minutes late: both the scheduled instant and the estimate are UK wall-clock. */
function delayMinutes(scheduledIso: string, estHhmm: string): number | undefined {
  const est = toMinutes(estHhmm);
  const sched = toMinutes(ukHhmm(scheduledIso));
  if (est === undefined || sched === undefined) return undefined;
  let delta = est - sched;
  // A large negative delta means the estimate crossed midnight past the schedule.
  if (delta < -720) delta += 1440;
  return delta;
}

function toMinutes(hhmmStr: string): number | undefined {
  const [h, m] = hhmmStr.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return undefined;
  return h * 60 + m;
}

export async function enrichBoardWithDarwin(
  crs: string,
  scheduled: BoardDeparture[],
): Promise<{ departures: BoardDeparture[]; live: boolean }> {
  const forecasts = await loadForecasts(crs);
  if (forecasts.size === 0) return { departures: scheduled, live: false };

  let anyLive = false;
  const departures = scheduled.map((row) => {
    const key = ukHhmm(row.scheduled);
    const candidates = forecasts.get(key);
    if (!candidates || candidates.length === 0) return row;
    // If multiple trains share a scheduled minute, prefer an exact platform match.
    const f =
      candidates.find((c) => row.platform && c.platform === row.platform) ?? candidates[0]!;
    anyLive = true;

    if (f.cancelled || f.suppressed) {
      return { ...row, rid: f.rid, status: "cancelled" as const, hasLive: true };
    }

    const estimate = hhmm(f.actDep) ?? hhmm(f.estDep);
    const delay = estimate ? delayMinutes(row.scheduled, estimate) : undefined;
    const status: BoardDeparture["status"] =
      delay !== undefined && delay > 1 ? "delayed" : "on-time";

    return {
      ...row,
      rid: f.rid,
      platform: f.platform ?? row.platform,
      platformChanged: f.platformChanged,
      status,
      delayMinutes: delay !== undefined && delay > 1 ? delay : undefined,
      live: estimate ?? undefined,
      hasLive: true,
    };
  });

  return { departures, live: anyLive };
}
