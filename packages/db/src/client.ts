import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

/**
 * Names this process's connections in `pg_stat_activity.application_name`.
 *
 * Defaults to `$SERVICE_NAME` so each service is identifiable without every
 * caller passing one. Worth setting: on 2026-07-29 a stray `train-service` from a
 * different checkout was writing this same database, and because every
 * connection was an anonymous "postgres.js" it took three wrong root-cause
 * theories to spot. With a name, `select application_name, client_addr,
 * count(*) from pg_stat_activity group by 1,2` identifies the intruder
 * immediately.
 */
function appName(explicit?: string): string {
  return explicit ?? process.env.SERVICE_NAME ?? "mainline";
}

/**
 * Pool limits, all overridable by env.
 *
 * `idle_timeout` is the important one. postgres.js defaults it to 0, meaning a
 * connection opens on first use and then stays open for the life of the
 * process. That turned one careless caller — a health route that built a new
 * client per request — into a steady leak that filled Postgres in about 15
 * minutes. With an idle timeout, the same mistake costs nothing for long.
 *
 * It also retires the workarounds this repo already carries for the missing
 * setting: one-shot CLI commands used to hang on exit because their pool never
 * let go (see services/etl/src/snap-stations.ts).
 */
const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 10);
const POOL_IDLE_TIMEOUT_S = Number(process.env.DB_POOL_IDLE_TIMEOUT ?? 30);
const POOL_MAX_LIFETIME_S = Number(process.env.DB_POOL_MAX_LIFETIME ?? 30 * 60);
const POOL_CONNECT_TIMEOUT_S = Number(process.env.DB_POOL_CONNECT_TIMEOUT ?? 10);

export function createDb(url = process.env.DATABASE_URL, applicationName?: string) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, {
    max: POOL_MAX,
    idle_timeout: POOL_IDLE_TIMEOUT_S,
    max_lifetime: POOL_MAX_LIFETIME_S,
    connect_timeout: POOL_CONNECT_TIMEOUT_S,
    connection: { application_name: appName(applicationName) },
  });
  return drizzle(client, { schema });
}

/**
 * The one pool a long-running service should use.
 *
 * Each createDb() call builds an independent pool. The ingest services were
 * calling it at module scope in several files each, so one container could hold
 * 30-40 backends while only ever needing a handful. This mirrors what
 * apps/web/lib/db.ts already does for the web app.
 *
 * Short-lived scripts can keep calling createDb() directly — they want a pool
 * they can close.
 */
let shared: ReturnType<typeof createDb> | null = null;

export function getSharedDb(): ReturnType<typeof createDb> {
  shared ??= createDb();
  return shared;
}
