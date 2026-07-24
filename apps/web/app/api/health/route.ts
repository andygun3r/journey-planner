import { NextResponse } from "next/server";
import { createDb } from "@mainline/db";
import { sql } from "drizzle-orm";
import Redis from "ioredis";

export const dynamic = "force-dynamic";

async function checkPostgres(): Promise<boolean> {
  try {
    const db = createDb();
    await db.execute(sql`select 1`);
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
  const [postgres, redis] = await Promise.all([checkPostgres(), checkRedis()]);
  const ok = postgres && redis;
  return NextResponse.json(
    { ok, postgres, redis, service: "mainline-web" },
    { status: ok ? 200 : 503 },
  );
}
