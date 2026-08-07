import {
  alert,
  commute,
  commuteCorridor,
  commuteHoliday,
  commuteLeg,
  commuteLegPin,
  darwinStopForecast,
  darwinTrain,
  getSharedDb,
  tripMapping,
  tripMappingForUid,
  user,
} from "@signaller/db";
import { createEngine, gtfsTripIdFromEngine, type RawItinerary } from "@signaller/routing-adapter";
import {
  dayOfWeekForDate,
  type Direction,
  isDateInHolidayRange,
  londonDate,
  londonWallTimeToIso,
} from "@signaller/shared";
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { publishAndPush } from "./alerts.js";

/**
 * Nightly corridor precompute. For each active commute leg + direction over the
 * next couple of service dates, resolve the trains that serve the leg's window
 * into a set of `train_uid`s and store them in `commute_corridor`. The Darwin
 * live hook then matches cancellations/delays against these uids cheaply.
 *
 * Resolution goes through the routing engine's plan() (which knows real times
 * and calling patterns) and translates each planned GTFS trip to a train_uid
 * via the `trip_mapping` Rosetta table. trip_mapping alone can't be used — it
 * carries no times/calling pattern. A leg/direction with pinned services
 * (commute_leg_pin) skips this entirely — see resolvePinnedCorridor.
 *
 * This is deliberately isolated from the Kafka consume path: it runs on a cron
 * (and once on boot) inside its own try/catch, so a MOTIS outage or a bad
 * commute can never crash live ingestion. On failure it simply leaves the
 * previous corridors in place.
 */

const db = getSharedDb();

/** How many service dates ahead to resolve (today + tomorrow). */
const HORIZON_DAYS = 2;

interface PinRow {
  direction: Direction;
  sequence: number;
  trainUid: string;
  gtfsTripId: string | null;
  originCrs: string;
  destCrs: string;
  schedDep: string;
  toc: string | null;
}

interface LegRow {
  commuteId: string;
  legId: string;
  homeCrs: string;
  dayOfWeek: number;
  workCrs: string;
  amWindowStart: string | null;
  amWindowEnd: string | null;
  pmWindowStart: string | null;
  pmWindowEnd: string | null;
  pins: PinRow[];
}

/** Service dates (YYYY-MM-DD, UK local) from today for HORIZON_DAYS days. */
function horizonDates(): string[] {
  const out: string[] = [];
  const base = new Date();
  for (let i = 0; i < HORIZON_DAYS; i++) {
    out.push(londonDate(new Date(base.getTime() + i * 86_400_000)));
  }
  return out;
}

function windowFor(leg: LegRow, dir: Direction): { start: string; end: string } | null {
  const start = dir === "am" ? leg.amWindowStart : leg.pmWindowStart;
  const end = dir === "am" ? leg.amWindowEnd : leg.pmWindowEnd;
  if (!start || !end) return null;
  return { start: start.slice(0, 5), end: end.slice(0, 5) };
}

/**
 * Full intermediate stop CRS list for one train_uid's running on serviceDate.
 * Today: read straight from Darwin (darwin_stop_forecast/darwin_train), if
 * it's broadcast yet. A future service date (tomorrow, within HORIZON_DAYS):
 * the same engine.plan() lookup the window-based path already does, narrowed
 * to the one itinerary whose trip matches the pin's known gtfsTripId — reuses
 * the routing engine rather than a second data source. Falls back to just
 * [originCrs, destCrs] if neither source has an answer (e.g. MOTIS down) —
 * best-effort, never blocks writing the corridor row.
 */
async function callingPointCrsList(
  trainUid: string,
  serviceDate: string,
  gtfsTripId: string | null,
  originCrs: string,
  destCrs: string,
): Promise<string[]> {
  const today = londonDate();
  if (serviceDate === today) {
    const trainRows = await db
      .select({ rid: darwinTrain.rid })
      .from(darwinTrain)
      .where(and(eq(darwinTrain.uid, trainUid), eq(darwinTrain.ssd, serviceDate)))
      .limit(1);
    const rid = trainRows[0]?.rid;
    if (rid) {
      const stops = await db
        .select({ crs: darwinStopForecast.crs })
        .from(darwinStopForecast)
        .where(eq(darwinStopForecast.rid, rid));
      const crsList = [...new Set(stops.map((s) => s.crs).filter(Boolean) as string[])];
      if (crsList.length > 0) return crsList;
    }
  }

  if (gtfsTripId) {
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
        if (rail.some((l) => gtfsTripIdFromEngine(l.tripId!) === gtfsTripId)) {
          const crsList = new Set<string>();
          for (const l of rail) {
            crsList.add(l.origin.stopId);
            crsList.add(l.destination.stopId);
            for (const c of l.intermediateCalls) crsList.add(c.stopId);
          }
          return [...crsList];
        }
      }
    } catch {
      // fall through to the origin/dest-only fallback below
    }
  }

  return [originCrs, destCrs];
}

/**
 * Validate each pinned train_uid against trip_mapping for this service date
 * and write corridor rows directly — no engine.plan() search needed, just a
 * single-trip lookup for the calling list. One commute_corridor row per
 * still-valid pinned train_uid, keeping alerts.ts's matching path completely
 * unchanged (it only ever reads commute_corridor).
 */
async function resolvePinnedCorridor(
  leg: LegRow,
  dir: Direction,
  serviceDate: string,
  pins: PinRow[],
): Promise<void> {
  const staleUids: string[] = [];
  const rows: (typeof commuteCorridor.$inferInsert)[] = [];

  for (const pin of pins) {
    const mapping = await tripMappingForUid(db, pin.trainUid, serviceDate, leg.dayOfWeek);
    if (!mapping) {
      staleUids.push(pin.trainUid);
      continue;
    }

    const stationCrsList = await callingPointCrsList(
      pin.trainUid,
      serviceDate,
      mapping.gtfsTripId,
      pin.originCrs,
      pin.destCrs,
    );

    rows.push({
      commuteId: leg.commuteId,
      serviceDate,
      direction: dir,
      trainUid: pin.trainUid,
      commuteLegId: leg.legId,
      originCrs: pin.originCrs,
      destCrs: pin.destCrs,
      schedDep: pin.schedDep,
      stationCrsList,
      tocs: pin.toc ? [pin.toc] : [],
      computedAt: new Date(),
    });
  }

  if (rows.length > 0) {
    await db
      .insert(commuteCorridor)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          commuteCorridor.commuteId,
          commuteCorridor.serviceDate,
          commuteCorridor.direction,
          commuteCorridor.trainUid,
        ],
        set: {
          commuteLegId: sql`excluded.commute_leg_id`,
          originCrs: sql`excluded.origin_crs`,
          destCrs: sql`excluded.dest_crs`,
          schedDep: sql`excluded.sched_dep`,
          stationCrsList: sql`excluded.station_crs_list`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  if (staleUids.length > 0) {
    await raisePinStaleAlerts(leg, dir, serviceDate, staleUids);
  }

  console.log(
    `[precompute] ${leg.commuteId.slice(0, 8)} ${dir} ${serviceDate} (pinned): ` +
      `${rows.length} valid, ${staleUids.length} stale`,
  );
}

/**
 * A pinned train_uid no longer matches trip_mapping for this service date
 * (timetable change / doesn't run) — must surface to the user, not silently
 * fall back. Reuses the alert table + Redis publish + Web Push plumbing from
 * alerts.ts's publishAndPush, but skips its commute_corridor join (a stale
 * pin has no corridor row to join from — that IS the failure); precompute
 * already has commuteId directly from its own commute/leg load.
 */
async function raisePinStaleAlerts(
  leg: LegRow,
  dir: Direction,
  serviceDate: string,
  staleUids: string[],
): Promise<void> {
  const owner = await db
    .select({ userId: commute.userId, label: commute.label, pushSubscription: user.pushSubscription })
    .from(commute)
    .innerJoin(user, eq(user.id, commute.userId))
    .where(eq(commute.id, leg.commuteId))
    .limit(1);
  const who = owner[0];
  if (!who) return;

  const dirWord = dir === "am" ? "morning" : "evening";
  for (const uid of staleUids) {
    const headline = `Your pinned ${dirWord} train no longer runs on this day — pick a new one`;
    const detail = `train_uid ${uid} did not match the current timetable for ${serviceDate}`;

    const inserted = await db
      .insert(alert)
      .values({
        commuteId: leg.commuteId,
        kind: "pin_stale",
        ref: uid,
        commuteLegId: leg.legId,
        direction: dir,
        serviceDate,
        headline,
        detail,
      })
      .onConflictDoNothing({
        target: [alert.commuteId, alert.ref, alert.kind, alert.serviceDate],
      })
      .returning({ id: alert.id });

    if (inserted.length === 0) continue; // already raised, dedupe hit

    await publishAndPush({
      alertId: inserted[0]!.id,
      commuteId: leg.commuteId,
      userId: who.userId,
      commuteLabel: who.label,
      kind: "pin_stale",
      headline,
      detail,
      direction: dir,
      serviceDate,
      pushSubscription: who.pushSubscription,
      redis: null, // precompute has no live SSE connection to publish to; Web Push still fires
    });
  }
}

/** Resolve the train_uids serving one leg/direction on one date. */
async function resolveCorridor(
  leg: LegRow,
  dir: Direction,
  serviceDate: string,
  holidays: { startDate: string; endDate: string }[],
): Promise<void> {
  // Day-of-week and holiday gating.
  if (dayOfWeekForDate(serviceDate) !== leg.dayOfWeek) return;
  if (isDateInHolidayRange(serviceDate, holidays)) return;

  const pinsForDir = leg.pins.filter((p) => p.direction === dir);
  if (pinsForDir.length > 0) {
    await resolvePinnedCorridor(leg, dir, serviceDate, pinsForDir);
    return;
  }

  const win = windowFor(leg, dir);
  if (!win) return;

  const originCrs = dir === "am" ? leg.homeCrs : leg.workCrs;
  const destCrs = dir === "am" ? leg.workCrs : leg.homeCrs;
  const when = londonWallTimeToIso(serviceDate, win.start);

  const engine = createEngine();
  let itineraries: RawItinerary[];
  try {
    itineraries = await engine.plan({ from: originCrs, to: destCrs, when, numItineraries: 8 });
  } catch (err) {
    console.error(
      `[precompute] plan ${originCrs}->${destCrs} ${serviceDate} ${dir} failed:`,
      (err as Error).message,
    );
    return; // fail soft — keep whatever corridor already exists
  }

  // Collect the first rail leg of each itinerary that departs within the window,
  // with its gtfs tripId and the CRS it calls at.
  interface Candidate {
    tripId: string;
    schedDep: string; // HH:MM
    stationCrsList: string[];
  }
  const candidates: Candidate[] = [];
  for (const it of itineraries) {
    const rail = it.legs.filter((l) => l.mode === "rail" && l.tripId);
    if (rail.length === 0) continue;
    const first = rail[0]!;
    const depHm = hhmm(first.origin.scheduled);
    if (!depHm || depHm < win.start || depHm > win.end) continue;
    const crsList = new Set<string>();
    for (const l of rail) {
      crsList.add(l.origin.stopId);
      crsList.add(l.destination.stopId);
      for (const c of l.intermediateCalls) crsList.add(c.stopId);
    }
    for (const l of rail) {
      candidates.push({
        tripId: gtfsTripIdFromEngine(l.tripId!),
        schedDep: depHm,
        stationCrsList: [...crsList],
      });
    }
  }
  if (candidates.length === 0) return;

  // Translate gtfs tripId -> train_uid via trip_mapping, gated to this date.
  const tripIds = [...new Set(candidates.map((c) => c.tripId))];
  const mappings = await db
    .select({
      gtfsTripId: tripMapping.gtfsTripId,
      trainUid: tripMapping.trainUid,
      daysMask: tripMapping.daysMask,
    })
    .from(tripMapping)
    .where(
      and(
        inArray(tripMapping.gtfsTripId, tripIds),
        lte(tripMapping.dateRunsFrom, serviceDate),
        gte(tripMapping.dateRunsTo, serviceDate),
        ne(tripMapping.stpIndicator, "C"),
      ),
    );

  const dowBit = 1 << leg.dayOfWeek;
  const uidByTrip = new Map<string, string>();
  const unmatched: string[] = [];
  for (const tid of tripIds) {
    const m = mappings.find((x) => x.gtfsTripId === tid && (x.daysMask & dowBit) !== 0);
    if (m) uidByTrip.set(tid, m.trainUid);
    else unmatched.push(tid);
  }
  if (unmatched.length > 0) {
    console.warn(
      `[precompute] ${unmatched.length}/${tripIds.length} tripIds had no trip_mapping row ` +
        `(${originCrs}->${destCrs} ${serviceDate} ${dir})`,
    );
  }

  // Build corridor rows keyed by train_uid (dedupe, keep earliest schedDep + widest CRS set).
  const byUid = new Map<string, { schedDep: string; crs: Set<string> }>();
  for (const cand of candidates) {
    const uid = uidByTrip.get(cand.tripId);
    if (!uid) continue;
    const existing = byUid.get(uid);
    if (existing) {
      if (cand.schedDep < existing.schedDep) existing.schedDep = cand.schedDep;
      for (const c of cand.stationCrsList) existing.crs.add(c);
    } else {
      byUid.set(uid, { schedDep: cand.schedDep, crs: new Set(cand.stationCrsList) });
    }
  }
  if (byUid.size === 0) return;

  const rows = [...byUid.entries()].map(([trainUid, v]) => ({
    commuteId: leg.commuteId,
    serviceDate,
    direction: dir,
    trainUid,
    commuteLegId: leg.legId,
    originCrs,
    destCrs,
    schedDep: v.schedDep,
    stationCrsList: [...v.crs],
    tocs: [] as string[],
    computedAt: new Date(),
  }));

  await db
    .insert(commuteCorridor)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        commuteCorridor.commuteId,
        commuteCorridor.serviceDate,
        commuteCorridor.direction,
        commuteCorridor.trainUid,
      ],
      set: {
        commuteLegId: sql`excluded.commute_leg_id`,
        originCrs: sql`excluded.origin_crs`,
        destCrs: sql`excluded.dest_crs`,
        schedDep: sql`excluded.sched_dep`,
        stationCrsList: sql`excluded.station_crs_list`,
        computedAt: sql`excluded.computed_at`,
      },
    });

  console.log(
    `[precompute] ${leg.commuteId.slice(0, 8)} ${dir} ${serviceDate} ${originCrs}->${destCrs}: ` +
      `${rows.length} trains`,
  );
}

/** HH:MM (UK local) of an ISO offset datetime string. */
function hhmm(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Recompute corridors for every commute across the horizon; prune stale rows. */
export async function precomputeAllCorridors(): Promise<void> {
  const started = Date.now();
  const dates = horizonDates();

  // Load all commutes + their legs, and holidays grouped by owning user.
  const commutes = await db
    .select({
      id: commute.id,
      userId: commute.userId,
      homeCrs: commute.homeCrs,
    })
    .from(commute);
  if (commutes.length === 0) {
    console.log("[precompute] no commutes — nothing to do");
    return;
  }

  const legs = await db.select().from(commuteLeg);
  const legIds = legs.map((l) => l.id);
  const pins = legIds.length > 0 ? await db.select().from(commuteLegPin) : [];
  const pinsByLeg = new Map<string, PinRow[]>();
  for (const p of pins) {
    const arr = pinsByLeg.get(p.commuteLegId) ?? [];
    arr.push({
      direction: p.direction as Direction,
      sequence: p.sequence,
      trainUid: p.trainUid,
      gtfsTripId: p.gtfsTripId,
      originCrs: p.originCrs,
      destCrs: p.destCrs,
      schedDep: p.schedDep,
      toc: p.toc,
    });
    pinsByLeg.set(p.commuteLegId, arr);
  }

  const legsByCommute = new Map<string, (typeof commuteLeg.$inferSelect)[]>();
  for (const l of legs) {
    const arr = legsByCommute.get(l.commuteId) ?? [];
    arr.push(l);
    legsByCommute.set(l.commuteId, arr);
  }

  const holidays = await db.select().from(commuteHoliday);
  const holidaysByUser = new Map<string, { startDate: string; endDate: string }[]>();
  for (const h of holidays) {
    const arr = holidaysByUser.get(h.userId) ?? [];
    arr.push({ startDate: h.startDate, endDate: h.endDate });
    holidaysByUser.set(h.userId, arr);
  }

  for (const c of commutes) {
    if (!c.homeCrs) continue; // commute without a home location can't be resolved
    const userHols = holidaysByUser.get(c.userId) ?? [];
    for (const leg of legsByCommute.get(c.id) ?? []) {
      const legRow: LegRow = {
        commuteId: c.id,
        legId: leg.id,
        homeCrs: c.homeCrs,
        dayOfWeek: leg.dayOfWeek,
        workCrs: leg.workCrs,
        amWindowStart: leg.amWindowStart,
        amWindowEnd: leg.amWindowEnd,
        pmWindowStart: leg.pmWindowStart,
        pmWindowEnd: leg.pmWindowEnd,
        pins: (pinsByLeg.get(leg.id) ?? []).sort((a, b) => a.sequence - b.sequence),
      };
      for (const serviceDate of dates) {
        await resolveCorridor(legRow, "am", serviceDate, userHols);
        await resolveCorridor(legRow, "pm", serviceDate, userHols);
      }
    }
  }

  // Prune corridors older than today (yesterday and before).
  const today = dates[0]!;
  const pruned = await db
    .delete(commuteCorridor)
    .where(lte(commuteCorridor.serviceDate, sql`${today}::date - 1`))
    .returning({ uid: commuteCorridor.trainUid });

  console.log(
    `[precompute] done in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${commutes.length} commutes, pruned ${pruned.length} stale rows)`,
  );
}

/** True when there are no corridor rows for today (used for a boot-time run). */
export async function corridorsEmptyForToday(): Promise<boolean> {
  const today = londonDate();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commuteCorridor)
    .where(eq(commuteCorridor.serviceDate, today));
  return (rows[0]?.n ?? 0) === 0;
}
