import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { nrTrainPosition, station, darwinTrain } from "@mainline/db";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// TEMPORARY diagnostic route — remove after the /map "0 trains" investigation
// is resolved. Not linked from any UI.
export async function GET() {
  const db = getDb();
  const FRESH_SECONDS = 20 * 60;
  const since = new Date(Date.now() - FRESH_SECONDS * 1000);

  const rawCount = await db.execute(
    sql`select count(*)::int as n from nr_train_position where last_reported_at is not null and last_reported_at >= ${since.toISOString()}::timestamptz`,
  );

  const drizzleCountNoJoin = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nrTrainPosition)
    .where(and(isNotNull(nrTrainPosition.lastReportedAt), gte(nrTrainPosition.lastReportedAt, since)));

  const drizzleCountWithJoin = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nrTrainPosition)
    .leftJoin(station, eq(nrTrainPosition.lastCrs, station.crs))
    .leftJoin(darwinTrain, eq(nrTrainPosition.rid, darwinTrain.rid))
    .where(and(isNotNull(nrTrainPosition.lastReportedAt), gte(nrTrainPosition.lastReportedAt, since)));

  const withLatLon = await db
    .select({
      trainId: nrTrainPosition.trainId,
      lastCrs: nrTrainPosition.lastCrs,
      lat: sql<number | null>`coalesce(${station.trackLat}, ${station.lat})`,
      lon: sql<number | null>`coalesce(${station.trackLon}, ${station.lon})`,
      stationName: station.name,
    })
    .from(nrTrainPosition)
    .leftJoin(station, eq(nrTrainPosition.lastCrs, station.crs))
    .where(and(isNotNull(nrTrainPosition.lastReportedAt), gte(nrTrainPosition.lastReportedAt, since)))
    .limit(10);

  const nonNullLatLonCount = await db.execute(
    sql`select count(*)::int as n from nr_train_position p left join station s on p.last_crs = s.crs where p.last_reported_at is not null and p.last_reported_at >= ${since.toISOString()}::timestamptz and coalesce(s.track_lat, s.lat) is not null`,
  );

  return NextResponse.json({
    sinceIso: since.toISOString(),
    nowIso: new Date().toISOString(),
    rawCount: rawCount[0],
    drizzleCountNoJoin: drizzleCountNoJoin[0],
    drizzleCountWithJoin: drizzleCountWithJoin[0],
    nonNullLatLonCount: nonNullLatLonCount[0],
    sampleRows: withLatLon,
  });
}
