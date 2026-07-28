import { darwinStopForecast, darwinTrain } from "@mainline/db";
import { and, eq, inArray } from "drizzle-orm";
import type { BoardDeparture } from "./board";
import { getDb } from "./db";
import { hhmmToIso, londonDateKey, minutesLate, ukHhmm } from "./uk-time";

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

/** Normalise Darwin "HH:MM[:SS]" to "HH:MM". */
function hhmm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

/** The service days a board's trains could belong to, London-local. */
function candidateServiceDays(now: Date): string[] {
  return [londonDateKey(new Date(now.getTime() - 86_400_000)), londonDateKey(now)];
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
      // Bounded to the current/previous service day. Without this, a scheduled
      // minute matches every train that has ever departed at that minute from
      // this station, and the row picks up an arbitrary one.
      .where(
        and(
          eq(darwinStopForecast.crs, crs),
          inArray(darwinTrain.ssd, candidateServiceDays(new Date())),
          eq(darwinTrain.deactivated, false),
        ),
      );
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

export async function enrichBoardWithDarwin(
  crs: string,
  scheduled: BoardDeparture[],
): Promise<{ departures: BoardDeparture[]; live: boolean }> {
  const forecasts = await loadForecasts(crs);
  if (forecasts.size === 0) return { departures: scheduled, live: false };

  let anyLive = false;
  const departures = scheduled.map((row) => {
    const key = ukHhmm(row.scheduled);
    const candidates = key ? forecasts.get(key) : undefined;
    if (!candidates || candidates.length === 0) return row;
    // If several trains share a scheduled minute, an exact platform match
    // identifies ours. Failing that, only a single candidate is unambiguous —
    // taking the first of several attaches some other train's live status to
    // this row, which is exactly the kind of jumbling this pass is fixing.
    const f =
      candidates.find((c) => row.platform && c.platform === row.platform) ??
      (candidates.length === 1 ? candidates[0]! : undefined);
    if (!f) return row;
    anyLive = true;

    if (f.cancelled || f.suppressed) {
      return { ...row, rid: f.rid, status: "cancelled" as const, hasLive: true };
    }

    const estimate = hhmm(f.actDep) ?? hhmm(f.estDep);
    // `live` is an ISO INSTANT everywhere else in the app (see BoardDeparture).
    // This used to assign the bare "HH:MM" string, so the board's formatter hit
    // `new Date("18:42")` and threw Invalid time value into the error boundary,
    // while LiveCountdown silently rendered nothing.
    const liveIso = hhmmToIso(estimate, new Date(row.scheduled));
    const delay = minutesLate(row.scheduled, liveIso);
    const status: BoardDeparture["status"] =
      delay !== undefined && delay > 1 ? "delayed" : liveIso ? "on-time" : "scheduled";

    return {
      ...row,
      rid: f.rid,
      platform: f.platform ?? row.platform,
      platformChanged: f.platformChanged,
      status,
      delayMinutes: delay !== undefined && delay > 1 ? delay : undefined,
      live: liveIso,
      hasLive: true,
    };
  });

  return { departures, live: anyLive };
}
