import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import Redis from "ioredis";
import { getDb } from "@/lib/db";
import { timetableStatus } from "@/lib/timetable-status";

export const dynamic = "force-dynamic";

/**
 * Uses the shared pool, NOT a fresh createDb().
 *
 * This route used to build its own client on every request and never close it.
 * Because the pool has no idle timeout, each one left its connections open for
 * the life of the process. Docker health-checks this endpoint every 10s, so it
 * leaked roughly 360 Postgres backends an hour against a default
 * max_connections of 100 — the database ran out of room in under 20 minutes,
 * which looks exactly like "the whole app got slow" from the outside.
 */
async function checkPostgres(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 2000 });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export async function GET() {
  const [postgres, redis, timetable] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    timetableStatus(),
  ]);

  // A stale timetable is reported but deliberately does NOT fail the check.
  // Docker restarts this container when the check fails, and restarting the web
  // app cannot fix a timetable import that stopped running — it would just add a
  // restart loop to an existing problem. `ok` stays about "can this process
  // serve requests"; the timetable block is there to be read.
  const ok = postgres && redis;
  return NextResponse.json(
    { ok, postgres, redis, timetable, service: "mainline-web" },
    { status: ok ? 200 : 503 },
  );
}
