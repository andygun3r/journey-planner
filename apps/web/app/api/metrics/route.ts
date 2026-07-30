import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import Redis from "ioredis";
import { getDb } from "@/lib/db";
import { busStats } from "@/lib/live-bus";

export const dynamic = "force-dynamic";

/**
 * Operational numbers, in one place.
 *
 * This exists because none of the app's behaviour was measurable. There was no
 * request timing, no query counts, and no view of the connection pool — so when
 * the server "felt slow" there was no way to tell whether the cause was the
 * routing engine, Postgres, or connections running out. Three wrong theories
 * came out of that gap before (see the note in packages/db/src/client.ts).
 *
 * Deliberately plain JSON rather than a Prometheus endpoint: there is no
 * scraper to point at it yet, and the point is to be able to read it with curl.
 * Swapping in prom-client later is easy if a dashboard ever arrives.
 *
 * Everything here is best-effort. A metrics page must never be the thing that
 * takes the site down, so each section falls back to null on error.
 */

interface ConnectionRow {
  application_name: string;
  total: number;
  active: number;
  idle: number;
}

async function postgresStats() {
  const db = getDb();

  // Connections, grouped the way client.ts's application_name tagging intended.
  // A steadily climbing total here is the signature of a pool leak.
  const connections = (await db.execute(sql`
    select
      coalesce(nullif(application_name, ''), '(unnamed)') as application_name,
      count(*)::int as total,
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle
    from pg_stat_activity
    where datname = current_database()
    group by 1
    order by total desc
  `)) as unknown as ConnectionRow[];

  const limits = (await db.execute(sql`
    select
      current_setting('max_connections')::int as max_connections,
      (select count(*)::int from pg_stat_activity) as total_backends
  `)) as unknown as Array<{ max_connections: number; total_backends: number }>;

  // Size and row estimates for the tables that actually grow. Uses the planner's
  // estimate rather than count(*) so this stays cheap on big tables.
  //
  // reltuples is -1 on a table that has never been analysed, which means "no
  // estimate", not "no rows" — report that as null rather than a bogus -1.
  // dead_rows matters here too: bulk DELETE retention leaves dead tuples
  // behind, so a number that stays high is a sign the prune is fighting
  // autovacuum.
  const tables = (await db.execute(sql`
    select
      c.relname as table,
      pg_total_relation_size(c.oid)::float8 as bytes,
      pg_size_pretty(pg_total_relation_size(c.oid)) as size,
      nullif(c.reltuples, -1)::float8 as estimated_rows,
      coalesce(s.n_dead_tup, 0)::float8 as dead_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in (
        'darwin_train', 'darwin_stop_forecast', 'darwin_formation',
        'nr_train_position', 'nr_train_position_history',
        'nr_signalling_state', 'nr_vstp_schedule', 'nr_tsr', 'alert'
      )
    order by pg_total_relation_size(c.oid) desc
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    connections,
    max_connections: limits[0]?.max_connections ?? null,
    total_backends: limits[0]?.total_backends ?? null,
    tables,
  };
}

/**
 * How far behind the feeds are.
 *
 * Age of the newest write in each hot table. If these climb into minutes, the
 * ingest services are not keeping up — which is what "live updates are stale"
 * looks like from the database side.
 */
async function ingestFreshness() {
  const db = getDb();
  const rows = (await db.execute(sql`
    select
      (select extract(epoch from now() - max(updated_at)) from darwin_stop_forecast)::int
        as darwin_forecast_age_s,
      (select extract(epoch from now() - max(updated_at)) from nr_train_position)::int
        as nr_position_age_s,
      (select extract(epoch from now() - max(recorded_at)) from nr_train_position_history)::int
        as nr_history_age_s,
      (select extract(epoch from now() - max(updated_at)) from nr_rtppm)::int
        as rtppm_age_s
  `)) as unknown as Array<Record<string, number | null>>;
  return rows[0] ?? null;
}

async function redisStats() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 2000 });
  try {
    await redis.connect();
    const info = await redis.info();
    const read = (key: string): string | null =>
      info.match(new RegExp(`^${key}:(.*)$`, "m"))?.[1]?.trim() ?? null;
    return {
      connected_clients: Number(read("connected_clients") ?? 0),
      used_memory_human: read("used_memory_human"),
      // One subscriber per browser tab is the anti-pattern to watch for here.
      pubsub_channels: Number(read("pubsub_channels") ?? 0),
      keys: await redis.dbsize(),
    };
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}

export async function GET() {
  const startedAt = Date.now();
  const [postgres, freshness, redis] = await Promise.all([
    postgresStats().catch(() => null),
    ingestFreshness().catch(() => null),
    redisStats().catch(() => null),
  ]);

  return NextResponse.json(
    {
      collected_in_ms: Date.now() - startedAt,
      postgres,
      ingest_freshness: freshness,
      redis,
      // Open live streams, and the channels behind them. `listeners` grows with
      // viewers; `channels` should not, and `redis.connected_clients` above
      // should stay flat regardless — that is the whole point of the shared bus.
      live_streams: busStats(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
