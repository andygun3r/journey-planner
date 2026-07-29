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

export function createDb(url = process.env.DATABASE_URL, applicationName?: string) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, {
    max: 10,
    connection: { application_name: appName(applicationName) },
  });
  return drizzle(client, { schema });
}
