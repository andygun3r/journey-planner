import { darwinStopForecast, nrTrainPosition, station } from "@mainline/db";
import { eq, inArray } from "drizzle-orm";
import type { BoardDeparture, BoardPosition } from "./board";
import { getDb } from "./db";

/**
 * Attaches a live "where is the train right now" position to each board row,
 * from the Network Rail overlay (nr_train_position, correlated to a Darwin rid
 * via TRUST activation). This is the between-station positioning Darwin can't
 * give: it turns a departure row into "6 mins away — passed Hatfield, 2 late".
 *
 * Match chain: board row (this station's CRS + scheduled HH:MM) ->
 * darwin_stop_forecast.rid -> nr_train_position by rid -> CRS-named location.
 * One bulk query set per board; a no-op when the NR ingester hasn't run.
 */

const ukHm = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});
const hhmm = (iso: string) => ukHm.format(new Date(iso));

export async function enrichBoardWithPosition(
  crs: string,
  departures: BoardDeparture[],
): Promise<BoardDeparture[]> {
  if (departures.length === 0) return departures;
  const db = getDb();

  // 1. rid for each row, by this station's scheduled departure minute.
  let forecasts: Array<{ rid: string; schedDep: string | null }>;
  try {
    forecasts = await db
      .select({ rid: darwinStopForecast.rid, schedDep: darwinStopForecast.schedDep })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.crs, crs));
  } catch {
    return departures; // NR/Darwin tables not ready — leave rows unchanged.
  }
  if (forecasts.length === 0) return departures;

  const ridByMinute = new Map<string, string>();
  for (const f of forecasts) if (f.schedDep) ridByMinute.set(f.schedDep.slice(0, 5), f.rid);

  const rids = [
    ...new Set(
      departures.map((d) => d.rid ?? ridByMinute.get(hhmm(d.scheduled))).filter(Boolean) as string[],
    ),
  ];
  if (rids.length === 0) return departures;

  // 2. NR position for those rids.
  const positions = await db
    .select({
      rid: nrTrainPosition.rid,
      lastCrs: nrTrainPosition.lastCrs,
      lastEvent: nrTrainPosition.lastEventType,
      lastReportedAt: nrTrainPosition.lastReportedAt,
      lateness: nrTrainPosition.lateness,
    })
    .from(nrTrainPosition)
    .where(inArray(nrTrainPosition.rid, rids));
  if (positions.length === 0) return departures;

  const posByRid = new Map(positions.filter((p) => p.rid).map((p) => [p.rid as string, p]));

  // 3. Name the location CRS values we actually need.
  const crsToName = new Map<string, string>();
  const crsNeeded = [...new Set(positions.map((p) => p.lastCrs).filter(Boolean) as string[])];
  if (crsNeeded.length > 0) {
    const names = await db
      .select({ crs: station.crs, name: station.name })
      .from(station)
      .where(inArray(station.crs, crsNeeded));
    for (const n of names) crsToName.set(n.crs, titleCase(n.name));
  }

  return departures.map((d) => {
    const rid = d.rid ?? ridByMinute.get(hhmm(d.scheduled));
    const p = rid ? posByRid.get(rid) : undefined;
    if (!p) return d;

    const where = p.lastCrs ? (crsToName.get(p.lastCrs) ?? p.lastCrs) : undefined;
    const verb =
      p.lastEvent === "ARRIVAL" ? "at" : p.lastEvent === "DEPARTURE" ? "departed" : "passed";
    // No station name yet (berth-only) — still say it's moving.
    const label = where ? `${verb === "at" ? "At" : cap(verb)} ${where}` : "On the move";

    const position: BoardPosition = {
      label,
      latenessMinutes:
        p.lateness !== null && p.lateness !== undefined ? Math.round(p.lateness / 60) : undefined,
      reportedAgoSeconds: p.lastReportedAt
        ? Math.round((Date.now() - p.lastReportedAt.getTime()) / 1000)
        : undefined,
      // If it hasn't reported a movement, or only a berth pass at origin, treat
      // as approaching. We keep it simple: any live NR report means it's tracked.
      approaching: false,
    };
    return { ...d, rid, position };
  });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** .MSN station names are ALL CAPS; title-case for display. */
function titleCase(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(On|Of|The|Upon|And|In|Under|Le|By)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}
