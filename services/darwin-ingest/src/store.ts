import { createDb, darwinFormation, darwinStopForecast, darwinTrain, station } from "@mainline/db";
import { eq, sql } from "drizzle-orm";
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

  const touchedCrs = new Set<string>();
  for (const stop of ts.stops) {
    const crs = tiplocToCrs.get(stop.tiploc) ?? null;
    if (crs) touchedCrs.add(crs);
    await db
      .insert(darwinStopForecast)
      .values({
        rid: ts.rid,
        seq: stop.seq,
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
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [darwinStopForecast.rid, darwinStopForecast.seq],
        set: {
          crs,
          estArr: normaliseTime(stop.arrEt),
          estDep: normaliseTime(stop.depEt),
          actArr: normaliseTime(stop.arrAt),
          actDep: normaliseTime(stop.depAt),
          platform: stop.platform ?? null,
          platformChanged: stop.platformConfirmed,
          suppressed: stop.suppressed,
          updatedAt: new Date(),
        },
      });
  }
  return [...touchedCrs];
}

export async function applySchedule(sch: ParsedSchedule): Promise<void> {
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
