import { createDb, darwinFormation, darwinStopForecast, darwinTrain, station } from "@mainline/db";
import { eq, or, sql } from "drizzle-orm";
import type {
  ParsedCoach,
  ParsedDeactivation,
  ParsedFormation,
  ParsedLoading,
  ParsedSchedule,
  ParsedTS,
} from "./pushport.js";

const db = createDb();

/** TIPLOC -> CRS, loaded once from the station table (refreshed hourly). */
let tiplocToCrs = new Map<string, string>();
let tiplocLoadedAt = 0;

async function ensureTiplocMap(): Promise<void> {
  if (tiplocToCrs.size > 0 && Date.now() - tiplocLoadedAt < 3_600_000) return;
  const rows = await db.select({ crs: station.crs, tiplocs: station.tiplocs }).from(station);
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const tpl of r.tiplocs) map.set(tpl, r.crs);
  }
  tiplocToCrs = map;
  tiplocLoadedAt = Date.now();
}

function normaliseTime(t?: string): string | null {
  return t ?? null;
}

export async function applyTS(ts: ParsedTS): Promise<string[]> {
  await ensureTiplocMap();

  await db
    .insert(darwinTrain)
    .values({ rid: ts.rid, uid: ts.uid, ssd: ts.ssd, lateReason: ts.lateReason })
    .onConflictDoUpdate({
      target: darwinTrain.rid,
      set: { lateReason: ts.lateReason ?? null, updatedAt: new Date() },
    });

  // seq is not reliable from a TS message alone (see darwin_stop_forecast's
  // schema comment): TS only ever carries a shifting subset of stops, so a
  // message-local index restarts from 0 every time and collides with seq
  // values already assigned (by applySchedule, or an earlier TS). This path
  // only runs when the SC message that would normally seed the authoritative
  // order was missed (e.g. after an ingest outage — see CLAUDE.md).
  //
  // For a stop this rid has never seen before, place it by scheduled time
  // relative to the stops we do know, NOT by TS message arrival order: TS
  // messages land per-station as trains progress, so a station's message can
  // arrive after a later station's, and appending in arrival order would
  // silently misorder the route (seen in practice: an origin stop's TS
  // arriving after a downstream stop's, making the app think the train had
  // already reached the end of its journey when it had barely started).
  const existingRows = await db
    .select({
      tiploc: darwinStopForecast.tiploc,
      seq: darwinStopForecast.seq,
      schedArr: darwinStopForecast.schedArr,
      schedDep: darwinStopForecast.schedDep,
    })
    .from(darwinStopForecast)
    .where(eq(darwinStopForecast.rid, ts.rid));
  const existingSeqByTiploc = new Map(existingRows.map((r) => [r.tiploc, r.seq]));
  const knownStops = existingRows
    .map((r) => ({ seq: r.seq, time: r.schedArr ?? r.schedDep }))
    .filter((r): r is { seq: number; time: string } => Boolean(r.time))
    .sort((a, b) => a.seq - b.seq);
  let nextSeq = existingRows.reduce((max, r) => Math.max(max, r.seq), -1) + 1;
  // seq is a smallint with no room for fractional/interpolated values, so a
  // stop slotting between two known seqs reuses the lower neighbour's seq
  // rather than averaging — ties are broken by scheduled time everywhere
  // seq-ordered stops are read (see resolveRid, enrichWithDarwinProgress).
  function seqForTime(time: string | null): number {
    if (!time || knownStops.length === 0) return nextSeq++;
    const after = knownStops.filter((s) => s.time <= time).at(-1);
    if (after) return after.seq;
    return knownStops[0]!.seq - 1;
  }

  const msgTs = ts.msgTs !== undefined ? new Date(ts.msgTs) : null;

  const touchedCrs = new Set<string>();
  for (const stop of ts.stops) {
    const crs = tiplocToCrs.get(stop.tiploc) ?? null;
    if (crs) touchedCrs.add(crs);
    const seq = existingSeqByTiploc.get(stop.tiploc) ?? seqForTime(stop.wta ?? stop.wtd ?? null);
    await db
      .insert(darwinStopForecast)
      .values({
        rid: ts.rid,
        seq,
        tiploc: stop.tiploc,
        crs,
        schedArr: normaliseTime(stop.wta),
        schedDep: normaliseTime(stop.wtd),
        estArr: normaliseTime(stop.arrEt),
        estDep: normaliseTime(stop.depEt),
        actArr: normaliseTime(stop.arrAt),
        actDep: normaliseTime(stop.depAt),
        platform: stop.platform ?? null,
        platformChanged: stop.platformConfirmed,
        suppressed: stop.suppressed,
        lastMsgTs: msgTs,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [darwinStopForecast.rid, darwinStopForecast.tiploc],
        set: {
          // seq intentionally NOT overwritten here: once a row exists (seeded
          // by applySchedule with the authoritative order, or by an earlier
          // TS), a later TS message must not reshuffle its position.
          crs,
          estArr: normaliseTime(stop.arrEt),
          estDep: normaliseTime(stop.depEt),
          actArr: normaliseTime(stop.arrAt),
          actDep: normaliseTime(stop.depAt),
          platform: stop.platform ?? null,
          platformChanged: stop.platformConfirmed,
          suppressed: stop.suppressed,
          lastMsgTs: msgTs,
          updatedAt: new Date(),
        },
        // Reject an out-of-order/replayed message (see CLAUDE.md's Kafka-offset-
        // reset gotcha): only overwrite live fields if this update is at least
        // as new as what's already stored, or nothing was stored yet. A message
        // with no timestamp of its own can't be compared, so it always applies.
        where:
          msgTs === null
            ? undefined
            : or(
                sql`${darwinStopForecast.lastMsgTs} is null`,
                sql`${msgTs.toISOString()}::timestamptz >= ${darwinStopForecast.lastMsgTs}`,
              ),
      });
  }
  return [...touchedCrs];
}

export async function applySchedule(sch: ParsedSchedule): Promise<void> {
  await ensureTiplocMap();

  await db
    .insert(darwinTrain)
    .values({
      rid: sch.rid,
      uid: sch.uid,
      ssd: sch.ssd,
      toc: sch.toc,
      cancelled: sch.cancelled,
      cancelReason: sch.cancelReason,
    })
    .onConflictDoUpdate({
      target: darwinTrain.rid,
      set: {
        toc: sch.toc ?? null,
        cancelled: sch.cancelled,
        cancelReason: sch.cancelReason ?? null,
        updatedAt: new Date(),
      },
    });

  // Seed the authoritative, stably-ordered calling pattern from the SC
  // message itself — the only Darwin message that carries the full route in
  // one shot. TS messages (applyTS) only ever patch existing rows by tiploc
  // from here on; they never get to assign seq for a row this seeded.
  for (const stop of sch.stops) {
    const crs = tiplocToCrs.get(stop.tiploc) ?? null;
    await db
      .insert(darwinStopForecast)
      .values({
        rid: sch.rid,
        seq: stop.seq,
        tiploc: stop.tiploc,
        crs,
        schedArr: normaliseTime(stop.wta),
        schedDep: normaliseTime(stop.wtd),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [darwinStopForecast.rid, darwinStopForecast.tiploc],
        set: {
          // A later SC re-issue (e.g. after a VSTP amendment) is itself
          // authoritative for ordering — safe to overwrite seq/crs/sched here,
          // unlike TS updates.
          seq: stop.seq,
          crs,
          schedArr: normaliseTime(stop.wta),
          schedDep: normaliseTime(stop.wtd),
          updatedAt: new Date(),
        },
      });
  }
}

export async function applyDeactivation(d: ParsedDeactivation): Promise<void> {
  await db
    .update(darwinTrain)
    .set({ deactivated: true, updatedAt: new Date() })
    .where(sql`${darwinTrain.rid} = ${d.rid}`);
}

/** scheduleFormations: set the coach layout (preserving any known loading). */
export async function applyFormation(f: ParsedFormation): Promise<void> {
  const existing = await db
    .select({ coaches: darwinFormation.coaches })
    .from(darwinFormation)
    .where(eq(darwinFormation.rid, f.rid))
    .limit(1);
  const priorLoading = new Map<string, number>();
  for (const c of (existing[0]?.coaches as ParsedCoach[] | undefined) ?? []) {
    if (c.loading !== undefined) priorLoading.set(c.number, c.loading);
  }
  const coaches: ParsedCoach[] = f.coaches.map((c) => ({
    ...c,
    loading: priorLoading.get(c.number),
  }));

  await db
    .insert(darwinFormation)
    .values({ rid: f.rid, fid: f.fid, coaches, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: darwinFormation.rid,
      set: { fid: f.fid, coaches, updatedAt: new Date() },
    });
}

/** formationLoading: merge live loading % onto the stored coaches by number. */
export async function applyLoading(l: ParsedLoading): Promise<void> {
  const existing = await db
    .select({ coaches: darwinFormation.coaches })
    .from(darwinFormation)
    .where(eq(darwinFormation.rid, l.rid))
    .limit(1);

  const pct = new Map(l.loading.map((x) => [x.number, x.percent]));

  if (existing.length === 0) {
    // Loading arrived before the layout — seed coaches from loading data.
    const coaches: ParsedCoach[] = l.loading.map((x) => ({
      number: x.number,
      first: false,
      loading: x.percent,
    }));
    await db
      .insert(darwinFormation)
      .values({ rid: l.rid, fid: l.fid, coaches, updatedAt: new Date() })
      .onConflictDoNothing();
    return;
  }

  const coaches = ((existing[0]!.coaches as ParsedCoach[]) ?? []).map((c) => ({
    ...c,
    loading: pct.get(c.number) ?? c.loading,
  }));
  await db
    .update(darwinFormation)
    .set({ coaches, updatedAt: new Date() })
    .where(eq(darwinFormation.rid, l.rid));
}
