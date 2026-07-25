import { darwinStopForecast, darwinTrain, nrTrainPosition, station } from "@mainline/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";

/**
 * The live train map's data source. Reads the Network Rail live-position table
 * (nr_train_position, kept fresh by services/nr-ingest from TRUST movements +
 * Train Describer) and turns each recently-reporting train into a plottable
 * point: last-reported station coordinates, nudged toward the next stop so a
 * train shows as "between stations", the way Open Train Times / Traksy do.
 *
 * There is no GPS for GB rail — position is derived from the last timing-point
 * or berth report. A train that reported ARRIVAL sits on its station; one that
 * reported DEPARTURE is drawn heading toward its next call.
 */

export interface LiveTrain {
  id: string;
  headcode?: string;
  operator?: string;
  /** Plotted position (WGS84). */
  lat: number;
  lon: number;
  /** Where it physically last reported. */
  atName?: string;
  atCrs?: string;
  event?: string;
  /** Where it's heading next (drives the nudge + the tooltip). */
  towardName?: string;
  destName?: string;
  latenessMinutes?: number;
  reportedAgoSeconds: number;
  /** Darwin rid, when correlated — lets the map link to the service page. */
  rid?: string;
}

export interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
}

/** Consider a train "live on the map" if it reported within this window. */
const FRESH_SECONDS = 20 * 60;

function titleCase(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(On|Of|The|Upon|And|In|Under|Le|By)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/** Small nudge from A toward B so departed trains sit between stations. */
function nudge(
  from: { lat: number; lon: number },
  toward: { lat: number; lon: number } | undefined,
  fraction: number,
): { lat: number; lon: number } {
  if (!toward) return from;
  return {
    lat: from.lat + (toward.lat - from.lat) * fraction,
    lon: from.lon + (toward.lon - from.lon) * fraction,
  };
}

export async function getLiveTrains(limit = 800): Promise<LiveTrainsResult> {
  const db = getDb();
  const since = new Date(Date.now() - FRESH_SECONDS * 1000);

  let rows: Array<{
    trainId: string;
    headcode: string | null;
    rid: string | null;
    lastCrs: string | null;
    lastEvent: string | null;
    lastReportedAt: Date | null;
    lateness: number | null;
    lat: number | null;
    lon: number | null;
    stationName: string | null;
  }>;
  try {
    rows = await db
      .select({
        trainId: nrTrainPosition.trainId,
        headcode: nrTrainPosition.headcode,
        rid: nrTrainPosition.rid,
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
        lat: station.lat,
        lon: station.lon,
        stationName: station.name,
      })
      .from(nrTrainPosition)
      .innerJoin(station, eq(nrTrainPosition.lastCrs, station.crs))
      .where(
        and(
          isNotNull(nrTrainPosition.lastReportedAt),
          gte(nrTrainPosition.lastReportedAt, since),
          isNotNull(station.lat),
        ),
      )
      .orderBy(sql`${nrTrainPosition.lastReportedAt} desc`)
      .limit(limit);
  } catch {
    return { generatedAt: new Date().toISOString(), count: 0, trains: [] };
  }

  if (rows.length === 0) {
    return { generatedAt: new Date().toISOString(), count: 0, trains: [] };
  }

  // For correlated trains, look up the next scheduled stop (for the nudge and
  // the destination label) in one query.
  const rids = [...new Set(rows.map((r) => r.rid).filter(Boolean) as string[])];
  const nextStopByRid = new Map<string, { crs: string; name?: string; lat?: number; lon?: number }>();
  const destByRid = new Map<string, string>();
  if (rids.length > 0) {
    const forecasts = await db
      .select({
        rid: darwinStopForecast.rid,
        seq: darwinStopForecast.seq,
        crs: darwinStopForecast.crs,
        actArr: darwinStopForecast.actArr,
        actDep: darwinStopForecast.actDep,
      })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.rid, rids));

    const byRid = new Map<string, typeof forecasts>();
    for (const f of forecasts) {
      const list = byRid.get(f.rid) ?? [];
      list.push(f);
      byRid.set(f.rid, list);
    }
    // Collect the CRS values whose coordinates we'll need for the next stop.
    const nextCrsNeeded = new Set<string>();
    const pendingNext = new Map<string, string>(); // rid -> next crs
    for (const [rid, list] of byRid) {
      const ordered = list.filter((s) => s.crs).sort((a, b) => a.seq - b.seq);
      const last = ordered[ordered.length - 1];
      if (!last) continue;
      if (last.crs) destByRid.set(rid, last.crs);
      // The first stop with no actual time is "next".
      const next = ordered.find((s) => !s.actArr && !s.actDep);
      if (next?.crs) {
        pendingNext.set(rid, next.crs);
        nextCrsNeeded.add(next.crs);
      }
    }
    // Coordinates + names for the next-stop and destination CRS values.
    const crsNeeded = [...new Set([...nextCrsNeeded, ...destByRid.values()])];
    const coords = new Map<string, { name: string; lat: number | null; lon: number | null }>();
    if (crsNeeded.length > 0) {
      const st = await db
        .select({ crs: station.crs, name: station.name, lat: station.lat, lon: station.lon })
        .from(station)
        .where(inArray(station.crs, crsNeeded));
      for (const s of st) coords.set(s.crs, { name: s.name, lat: s.lat, lon: s.lon });
    }
    for (const [rid, crs] of pendingNext) {
      const c = coords.get(crs);
      nextStopByRid.set(rid, {
        crs,
        name: c ? titleCase(c.name) : undefined,
        lat: c?.lat ?? undefined,
        lon: c?.lon ?? undefined,
      });
    }
    // Swap dest CRS for a display name.
    for (const [rid, crs] of destByRid) {
      const c = coords.get(crs);
      if (c) destByRid.set(rid, titleCase(c.name));
    }
  }

  const now = Date.now();
  const trains: LiveTrain[] = rows
    .filter((r) => r.lat !== null && r.lon !== null)
    .map((r) => {
      const from = { lat: r.lat as number, lon: r.lon as number };
      const next = r.rid ? nextStopByRid.get(r.rid) : undefined;
      const toward =
        next && next.lat != null && next.lon != null ? { lat: next.lat, lon: next.lon } : undefined;
      // Departed => halfway to next; arrived/pass => sit on the station.
      const fraction = r.lastEvent === "DEPARTURE" ? 0.5 : 0.08;
      const pos = nudge(from, toward, fraction);
      return {
        id: r.trainId,
        headcode: r.headcode ?? undefined,
        lat: Number(pos.lat.toFixed(5)),
        lon: Number(pos.lon.toFixed(5)),
        atName: r.stationName ? titleCase(r.stationName) : undefined,
        atCrs: r.lastCrs ?? undefined,
        event: r.lastEvent ?? undefined,
        towardName: next?.name,
        destName: r.rid ? destByRid.get(r.rid) : undefined,
        latenessMinutes:
          r.lateness !== null && r.lateness !== undefined ? Math.round(r.lateness / 60) : undefined,
        // Clamp to >= 0: TRUST timestamps can read slightly ahead of our clock
        // (clock skew / BST edge), which would otherwise show a negative "ago".
        reportedAgoSeconds: r.lastReportedAt
          ? Math.max(0, Math.round((now - r.lastReportedAt.getTime()) / 1000))
          : 0,
        rid: r.rid ?? undefined,
      };
    });

  void darwinTrain;
  return { generatedAt: new Date().toISOString(), count: trains.length, trains };
}
