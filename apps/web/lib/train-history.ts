import { darwinStopForecast, darwinTrain, nrCorpus, nrHeadcode, nrTrainPositionHistory, station } from "@signaller/db";
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
 *
 * TD berth-step rows (the actual junction/berth detail — see nr-ingest's
 * applyBerthStep) are written keyed by headcode only, never rid: TD doesn't
 * carry one. A rid-only query here would silently miss all of them. When the
 * caller only has a rid, resolve it to this train's headcode the same way
 * service-progress.ts does (rid -> uid -> nr_headcode) so TD rows are found.
 *
 * A resolved headcode is NOT unique to this run: the same 4-character
 * headcode is reassigned to different physical trains across the day (seen
 * in practice: a Waterloo-Guildford service's history showing an unrelated
 * Moorgate-line run's berth passes from earlier that afternoon, spliced onto
 * the front). Once a headcode is known, its matched rows are filtered to
 * only those whose location is actually on this rid's own route — same
 * discipline as the live-position guards in service-progress.ts / board-position.ts.
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
  const { trainId, rid } = opts;
  let headcode = opts.headcode;
  if (!trainId && !rid && !headcode) return [];

  const db = getDb();

  if (rid && !headcode) {
    try {
      const train = await db
        .select({ uid: darwinTrain.uid })
        .from(darwinTrain)
        .where(eq(darwinTrain.rid, rid))
        .limit(1);
      const uid = train[0]?.uid;
      if (uid) {
        const hc = await db
          .select({ headcode: nrHeadcode.headcode })
          .from(nrHeadcode)
          .where(eq(nrHeadcode.uid, uid))
          .limit(1);
        headcode = hc[0]?.headcode ?? undefined;
      }
    } catch {
      // leave headcode unresolved — rid/trainId filters still apply below
    }
  }

  const since = new Date(Date.now() - SINCE_HOURS * 3_600_000);

  type Row = {
    reportedAt: Date;
    lastEventType: string | null;
    lastStanox: string | null;
    lastCrs: string | null;
    tdArea: string | null;
    berth: string | null;
    lateness: number | null;
  };
  const cols = {
    reportedAt: nrTrainPositionHistory.reportedAt,
    lastEventType: nrTrainPositionHistory.lastEventType,
    lastStanox: nrTrainPositionHistory.lastStanox,
    lastCrs: nrTrainPositionHistory.lastCrs,
    tdArea: nrTrainPositionHistory.tdArea,
    berth: nrTrainPositionHistory.berth,
    lateness: nrTrainPositionHistory.lateness,
  };

  // trainId/rid rows are unambiguous (rid is only ever set via TRUST
  // activation matching train_uid) — no extra filtering needed.
  const directFilters = [
    trainId ? eq(nrTrainPositionHistory.trainId, trainId) : undefined,
    rid ? eq(nrTrainPositionHistory.rid, rid) : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  let rows: Row[] = [];
  try {
    if (directFilters.length > 0) {
      rows = await db
        .select(cols)
        .from(nrTrainPositionHistory)
        .where(and(or(...directFilters), gte(nrTrainPositionHistory.reportedAt, since)))
        .orderBy(desc(nrTrainPositionHistory.reportedAt))
        .limit(MAX_ROWS);
    }

    if (headcode) {
      const hcRows = await db
        .select(cols)
        .from(nrTrainPositionHistory)
        .where(
          and(eq(nrTrainPositionHistory.headcode, headcode), gte(nrTrainPositionHistory.reportedAt, since)),
        )
        .orderBy(desc(nrTrainPositionHistory.reportedAt))
        .limit(MAX_ROWS);

      // The headcode may have belonged to a different physical train earlier
      // in the day: only keep rows whose location is on this rid's own route.
      let routeCrs: Set<string> | null = null;
      if (rid) {
        try {
          const forecasts = await db
            .select({ crs: darwinStopForecast.crs })
            .from(darwinStopForecast)
            .where(eq(darwinStopForecast.rid, rid));
          routeCrs = new Set(forecasts.map((f) => f.crs).filter((c): c is string => Boolean(c)));
        } catch {
          routeCrs = null; // fall through to accepting all headcode rows
        }
      }
      const filtered = routeCrs
        ? hcRows.filter((r) => r.lastCrs && routeCrs!.has(r.lastCrs))
        : hcRows;
      rows.push(...filtered);
    }
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  // Merge, dedupe (a row can match both a direct filter and the headcode
  // filter), and sort chronologically for the UI.
  const seen = new Set<string>();
  rows = rows
    .filter((r) => {
      const key = `${r.reportedAt.getTime()}|${r.lastStanox ?? ""}|${r.tdArea ?? ""}|${r.berth ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime())
    .slice(-MAX_ROWS);

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
