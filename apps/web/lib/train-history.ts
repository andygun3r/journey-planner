import { darwinStopForecast, nrCorpus, nrTrainPositionHistory, station } from "@mainline/db";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { getDb } from "./db";

/**
 * The service-detail page's "advanced view": a timestamped list of every
 * junction/berth actually passed, sourced from nr_train_position_history
 * (an append-only log — see packages/db/src/schema.ts). Names are resolved
 * via nr_corpus (STANOX -> CRS/description); where a row's location matches a
 * darwin_stop_forecast timing point for the same rid, we attach the scheduled
 * time for comparison. Most berth passes have no scheduled match — SMART is
 * far more granular than the timetable — and render as "passed, no schedule"
 * rather than being hidden.
 */

export interface PositionHistoryEntry {
  reportedAt: string;
  eventType: string;
  locationName?: string;
  stanox?: string;
  tdArea?: string;
  berth?: string;
  latenessMinutes?: number;
  scheduled?: { crs: string; time: string } | null;
}

const MAX_ROWS = 200;
const SINCE_HOURS = 12;

export async function getPositionHistory(opts: {
  trainId?: string;
  rid?: string;
  headcode?: string;
}): Promise<PositionHistoryEntry[]> {
  const { trainId, rid, headcode } = opts;
  if (!trainId && !rid && !headcode) return [];

  const db = getDb();
  const since = new Date(Date.now() - SINCE_HOURS * 3_600_000);

  const idFilters = [
    trainId ? eq(nrTrainPositionHistory.trainId, trainId) : undefined,
    rid ? eq(nrTrainPositionHistory.rid, rid) : undefined,
    headcode ? eq(nrTrainPositionHistory.headcode, headcode) : undefined,
  ].filter(Boolean);
  if (idFilters.length === 0) return [];

  let rows: Array<{
    reportedAt: Date;
    lastEventType: string | null;
    lastStanox: string | null;
    lastCrs: string | null;
    tdArea: string | null;
    berth: string | null;
    lateness: number | null;
  }>;
  try {
    rows = await db
      .select({
        reportedAt: nrTrainPositionHistory.reportedAt,
        lastEventType: nrTrainPositionHistory.lastEventType,
        lastStanox: nrTrainPositionHistory.lastStanox,
        lastCrs: nrTrainPositionHistory.lastCrs,
        tdArea: nrTrainPositionHistory.tdArea,
        berth: nrTrainPositionHistory.berth,
        lateness: nrTrainPositionHistory.lateness,
      })
      .from(nrTrainPositionHistory)
      .where(and(or(...idFilters), gte(nrTrainPositionHistory.reportedAt, since)))
      .orderBy(desc(nrTrainPositionHistory.reportedAt))
      .limit(MAX_ROWS);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  rows.reverse(); // chronological order for the UI

  // Resolve human-readable names for any STANOX without a direct CRS.
  const stanoxNeeded = [...new Set(rows.map((r) => r.lastStanox).filter(Boolean) as string[])];
  const nameByStanox = new Map<string, { crs: string | null; description: string | null }>();
  if (stanoxNeeded.length > 0) {
    try {
      const corpus = await db
        .select({
          stanox: nrCorpus.stanox,
          crs: nrCorpus.crs,
          description: nrCorpus.description,
        })
        .from(nrCorpus)
        .where(inArray(nrCorpus.stanox, stanoxNeeded));
      for (const c of corpus) nameByStanox.set(c.stanox, { crs: c.crs, description: c.description });
    } catch {
      // leave nameByStanox empty — rows fall back to STANOX/CRS as-is
    }
  }

  const crsNeeded = [
    ...new Set(
      rows
        .map((r) => r.lastCrs ?? (r.lastStanox ? nameByStanox.get(r.lastStanox)?.crs : undefined))
        .filter(Boolean) as string[],
    ),
  ];
  const stationNameByCrs = new Map<string, string>();
  if (crsNeeded.length > 0) {
    try {
      const stations = await db
        .select({ crs: station.crs, name: station.name })
        .from(station)
        .where(inArray(station.crs, crsNeeded));
      for (const s of stations) stationNameByCrs.set(s.crs, s.name);
    } catch {
      // leave stationNameByCrs empty — rows fall back to descriptions/STANOX
    }
  }

  // Scheduled-vs-actual: match against this rid's darwin_stop_forecast timing
  // points by CRS, where we have one.
  const schedByCrs = new Map<string, string>();
  if (rid) {
    try {
      const forecasts = await db
        .select({
          crs: darwinStopForecast.crs,
          schedArr: darwinStopForecast.schedArr,
          schedDep: darwinStopForecast.schedDep,
        })
        .from(darwinStopForecast)
        .where(eq(darwinStopForecast.rid, rid));
      for (const f of forecasts) {
        if (!f.crs) continue;
        const t = f.schedArr ?? f.schedDep;
        if (t) schedByCrs.set(f.crs, t.slice(0, 5));
      }
    } catch {
      // leave schedByCrs empty — entries just render without a scheduled match
    }
  }

  return rows.map((r) => {
    const crs = r.lastCrs ?? (r.lastStanox ? nameByStanox.get(r.lastStanox)?.crs ?? undefined : undefined);
    const locationName =
      (crs ? stationNameByCrs.get(crs) : undefined) ??
      (r.lastStanox ? nameByStanox.get(r.lastStanox)?.description ?? undefined : undefined) ??
      (r.tdArea && r.berth ? `${r.tdArea} berth ${r.berth}` : undefined);
    const scheduledTime = crs ? schedByCrs.get(crs) : undefined;

    return {
      reportedAt: r.reportedAt.toISOString(),
      eventType: r.lastEventType ?? "PASS",
      locationName,
      stanox: r.lastStanox ?? undefined,
      tdArea: r.tdArea ?? undefined,
      berth: r.berth ?? undefined,
      latenessMinutes:
        r.lateness !== null && r.lateness !== undefined ? Math.round(r.lateness / 60) : undefined,
      scheduled: crs && scheduledTime ? { crs, time: scheduledTime } : null,
    };
  });
}
