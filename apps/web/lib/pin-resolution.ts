import { createEngine, gtfsTripIdFromEngine } from "@signaller/routing-adapter";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { darwinStopForecast, darwinTrain, getSharedDb, tripMapping, tripMappingForUid } from "@signaller/db";
import { dayOfWeekForDate, londonDate, londonWallTimeToIso } from "@signaller/shared";
import { candidateServiceDays } from "./darwin-forecasts";
import { getDb } from "./db";
import { fetchServiceDetails, isRidServiceId, ridFromServiceId, trainByRid } from "./service-details";

/**
 * Resolves a departure-board pick to its Network Rail train_uid — the stable
 * identity for a pinned commute leg (never a Darwin rid, which is per-day and
 * ephemeral, and never a GTFS trip id alone, which is a routing-engine
 * artifact remapped across timetable versions — see commute_leg_pin's doc
 * comment in packages/db/src/schema.ts).
 *
 * The commute leg picker resolves a routed leg (from /api/commute/leg-options,
 * which plans origin → destination through the engine) and so supplies a bare
 * GTFS trip id. Other callers may instead hold a departure-board row's
 * identity, which differs by source (apps/web/lib/board.ts):
 *  - LDBWS-primary: tripId = LDBWS serviceID, rid usually absent.
 *  - MOTIS-fallback: tripId = GTFS trip id, rid present only if
 *    enrichBoardWithDarwin correlated it.
 * All of these are accepted; the paths below try them cheapest-first.
 *
 * Picking for a day-of-week that isn't today means Darwin has nothing to
 * correlate — that case always resolves via trip_mapping keyed on the GTFS
 * trip id (path 4 below), never via a Darwin lookup.
 */

export interface ResolvedPinCandidate {
  trainUid: string;
  gtfsTripId: string | null;
  ssd: string;
}

export interface ResolveTrainUidInput {
  rid?: string;
  /** LDBWS serviceID, or "rid:<rid>" per service-details.ts's convention. */
  serviceId?: string;
  /** GTFS trip id, present on MOTIS-fallback board rows. */
  gtfsTripId?: string;
  /** YYYY-MM-DD; omitted = today (Darwin-first path). */
  targetDate?: string;
}

/**
 * Best-known scheduled arrival HH:MM at destCrs for a resolved candidate —
 * needed by the picker to record a pin's schedArr (a board row only gives a
 * departure time and the service's overall destination name, not the
 * arrival time at whatever intermediate/final station the user is changing
 * at). Today: read straight from darwin_stop_forecast via the resolved rid.
 * A future day-of-week pick: one engine.plan() lookup narrowed to the known
 * gtfsTripId, same technique precompute.ts's callingPointCrsList uses.
 */
export async function resolveArrival(
  candidate: ResolvedPinCandidate,
  originCrs: string,
  destCrs: string,
  serviceDate: string,
): Promise<string | null> {
  const today = londonDate();
  if (serviceDate === today) {
    const trainRows = await getDb()
      .select({ rid: darwinTrain.rid })
      .from(darwinTrain)
      .where(and(eq(darwinTrain.uid, candidate.trainUid), eq(darwinTrain.ssd, serviceDate)))
      .limit(1);
    const rid = trainRows[0]?.rid;
    if (rid) {
      const rows = await getDb()
        .select({ crs: darwinStopForecast.crs, schedArr: darwinStopForecast.schedArr, schedDep: darwinStopForecast.schedDep })
        .from(darwinStopForecast)
        .where(eq(darwinStopForecast.rid, rid));
      const stop = rows.find((r) => r.crs === destCrs);
      const hhmm = (stop?.schedArr ?? stop?.schedDep)?.slice(0, 5);
      if (hhmm) return hhmm;
    }
  }

  if (candidate.gtfsTripId) {
    try {
      const engine = createEngine();
      const itineraries = await engine.plan({
        from: originCrs,
        to: destCrs,
        when: londonWallTimeToIso(serviceDate, "00:00"),
        numItineraries: 8,
      });
      for (const it of itineraries) {
        const rail = it.legs.filter((l) => l.mode === "rail" && l.tripId);
        const match = rail.find((l) => gtfsTripIdFromEngine(l.tripId!) === candidate.gtfsTripId);
        if (match) {
          const d = new Date(match.destination.scheduled);
          if (!Number.isNaN(d.getTime())) {
            return new Intl.DateTimeFormat("en-GB", {
              timeZone: "Europe/London",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(d);
          }
        }
      }
    } catch {
      // best-effort — caller falls back to using the departure time
    }
  }

  return null;
}

/** train_uid via trip_mapping, keyed on a known GTFS trip id — no Darwin dependency. */
async function resolveByGtfsTripId(
  gtfsTripId: string,
  targetDate: string,
): Promise<ResolvedPinCandidate | null> {
  const db = getSharedDb();
  const dow = dayOfWeekForDate(targetDate);
  const dowBit = 1 << dow;
  const rows = await db
    .select({
      trainUid: tripMapping.trainUid,
      daysMask: tripMapping.daysMask,
    })
    .from(tripMapping)
    .where(
      and(
        eq(tripMapping.gtfsTripId, gtfsTripId),
        lte(tripMapping.dateRunsFrom, targetDate),
        gte(tripMapping.dateRunsTo, targetDate),
        ne(tripMapping.stpIndicator, "C"),
      ),
    );
  const match = rows.find((r) => (r.daysMask & dowBit) !== 0);
  return match ? { trainUid: match.trainUid, gtfsTripId, ssd: targetDate } : null;
}

/** Path 3: join darwin_stop_forecast/darwin_train by (crs, scheduled minute), bounded to today/yesterday. */
async function resolveByStationMinute(
  crs: string,
  scheduledHhmm: string,
): Promise<ResolvedPinCandidate | null> {
  const db = getDb();
  const rows = await db
    .select({ uid: darwinTrain.uid, ssd: darwinTrain.ssd, schedDep: darwinStopForecast.schedDep })
    .from(darwinStopForecast)
    .innerJoin(darwinTrain, eq(darwinTrain.rid, darwinStopForecast.rid))
    .where(
      and(
        eq(darwinStopForecast.crs, crs),
        inArray(darwinTrain.ssd, candidateServiceDays(new Date())),
        eq(darwinTrain.deactivated, false),
      ),
    );
  const match = rows.find((r) => (r.schedDep ?? "").slice(0, 5) === scheduledHhmm);
  return match ? { trainUid: match.uid, gtfsTripId: null, ssd: match.ssd } : null;
}

/** train_uid + gtfsTripId (via trip_mapping, best-effort) for a resolved rid. */
async function fromRid(rid: string): Promise<ResolvedPinCandidate | null> {
  const train = await trainByRid(rid);
  if (!train) return null;
  const dow = dayOfWeekForDate(train.ssd);
  const mapping = await tripMappingForUid(getSharedDb(), train.uid, train.ssd, dow);
  return { trainUid: train.uid, gtfsTripId: mapping?.gtfsTripId ?? null, ssd: train.ssd };
}

/**
 * Extra inputs only path 3 needs — the board row's own crs/scheduled time,
 * required when neither a rid nor a resolvable serviceId is available.
 */
export interface ResolveTrainUidContext {
  crs?: string;
  scheduledHhmm?: string; // HH:MM
}

export async function resolveTrainUid(
  input: ResolveTrainUidInput,
  ctx: ResolveTrainUidContext = {},
): Promise<ResolvedPinCandidate | null> {
  const today = londonDate();

  // Future day-of-week picks: Darwin has nothing to correlate, go straight to
  // trip_mapping via the board row's GTFS trip id.
  if (input.targetDate && input.targetDate !== today) {
    return input.gtfsTripId ? resolveByGtfsTripId(input.gtfsTripId, input.targetDate) : null;
  }

  // Path 1: rid already known (either passed directly, or "rid:"-prefixed serviceId).
  const directRid = input.rid ?? (input.serviceId && isRidServiceId(input.serviceId) ? ridFromServiceId(input.serviceId) : null);
  if (directRid) {
    const resolved = await fromRid(directRid);
    if (resolved) return resolved;
  }

  // Path 2: LDBWS serviceID — Service Details resolves its own rid internally.
  if (input.serviceId && !isRidServiceId(input.serviceId)) {
    const details = await fetchServiceDetails(input.serviceId).catch(() => null);
    if (details?.rid) {
      const resolved = await fromRid(details.rid);
      if (resolved) return resolved;
    }
  }

  // Path 3: crs + scheduled minute join, bounded to today/yesterday.
  if (ctx.crs && ctx.scheduledHhmm) {
    const resolved = await resolveByStationMinute(ctx.crs, ctx.scheduledHhmm);
    if (resolved) return resolved;
  }

  // Path 4: fall back to trip_mapping via GTFS trip id (today, Darwin silent so far).
  if (input.gtfsTripId) {
    return resolveByGtfsTripId(input.gtfsTripId, today);
  }

  return null;
}
