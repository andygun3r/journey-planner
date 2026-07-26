import { darwinFormation, darwinStopForecast } from "@mainline/db";
import { eq, inArray } from "drizzle-orm";
import type { BoardDeparture, Coach } from "./board";
import { getDb } from "./db";

/**
 * Fills coach formation on board rows from the Darwin feed (darwin_formation),
 * for the operators/services where LDBWS returned no coaches. Matching:
 *   board row (crs, scheduled HH:MM) -> darwin_stop_forecast.rid -> formation.
 * Runs one bulk query per board; a no-op when the ingester hasn't populated
 * anything (rows pass through unchanged).
 */

interface StoredCoach {
  number: string;
  coachClass?: string;
  first: boolean;
  loading?: number;
}

const ukHm = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

function hhmm(iso: string): string {
  return ukHm.format(new Date(iso));
}

export async function enrichBoardWithFormation(
  crs: string,
  departures: BoardDeparture[],
): Promise<BoardDeparture[]> {
  // Only bother for rows still missing coach detail.
  const needy = departures.filter((d) => !d.coachCount);
  if (needy.length === 0) return departures;

  const db = getDb();

  // 1. rid by scheduled departure minute at this station.
  let forecasts: Array<{ rid: string; schedDep: string | null }>;
  try {
    forecasts = await db
      .select({ rid: darwinStopForecast.rid, schedDep: darwinStopForecast.schedDep })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.crs, crs));
  } catch {
    return departures; // DB/table not ready
  }
  if (forecasts.length === 0) return departures;

  const ridByMinute = new Map<string, string>();
  for (const f of forecasts) {
    if (f.schedDep) ridByMinute.set(f.schedDep.slice(0, 5), f.rid);
  }

  // 2. formation for the rids we can match.
  const rids = [...new Set(needy.map((d) => ridByMinute.get(hhmm(d.scheduled))).filter(Boolean))] as string[];
  if (rids.length === 0) return departures;

  const rows = await db
    .select({ rid: darwinFormation.rid, coaches: darwinFormation.coaches })
    .from(darwinFormation)
    .where(inArray(darwinFormation.rid, rids));
  const formationByRid = new Map(rows.map((r) => [r.rid, r.coaches as StoredCoach[]]));

  // 3. attach.
  return departures.map((d) => {
    if (d.coachCount) return d;
    const rid = ridByMinute.get(hhmm(d.scheduled));
    const stored = rid ? formationByRid.get(rid) : undefined;
    if (!stored || stored.length === 0) return d;
    const coaches: Coach[] = stored.map((c) => ({
      number: c.number,
      first: c.first,
      coachClass: c.coachClass,
      loading: c.loading,
    }));
    return { ...d, rid, coachCount: coaches.length, coaches };
  });
}
