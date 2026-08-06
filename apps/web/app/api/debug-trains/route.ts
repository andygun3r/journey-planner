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

  return NextResponse.json({
    sinceIso: since.toISOString(),
    nowIso: new Date().toISOString(),
    rawCount: rawCount.rows?.[0] ?? rawCount[0],
    drizzleCountNoJoin: drizzleCountNoJoin[0],
    drizzleCountWithJoin: drizzleCountWithJoin[0],
  });
}
