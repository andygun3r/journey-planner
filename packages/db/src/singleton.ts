import postgres from "postgres";

/**
 * Refuse to start if another instance of this service is already running
 * against the same database.
 *
 * Services like nr-ingest and darwin-ingest are exactly-one-writer by design:
 * each consumes a live feed and upserts rows keyed on a train id. Two of them
 * on one database don't split the work, they *fight* over it — each resolves a
 * rid independently and overwrites the other's, so the same row flickers
 * between two answers.
 *
 * That is not hypothetical. On 2026-07-29 a `train-service` from an unrelated
 * checkout (~/Documents/mainline-services) was pointed at this database and ran
 * alongside nr-ingest for hours. It produced symptoms that look exactly like
 * application-level concurrency bugs — history rows disagreeing with the live
 * snapshot, rids reverting after being correctly cleared, one train apparently
 * reporting from two signalling areas at once — and cost three separate wrong
 * root-cause diagnoses before `pg_stat_activity` revealed the second writer.
 * Silent corruption is the worst possible failure mode; this converts it into a
 * loud refusal at startup.
 *
 * Implementation notes:
 *   - `pg_try_advisory_lock` is *session*-scoped, so the holding connection has
 *     to stay open for the life of the process. It therefore gets its own
 *     dedicated single connection rather than borrowing from the pooled client,
 *     where a pool returning the connection would drop the lock.
 *   - The lock is released automatically when the process exits (or dies), so
 *     no cleanup path can leak it and permanently wedge future startups.
 *   - Key is derived from the service name, so different services don't block
 *     each other — only two copies of the *same* service do.
 */

/** Stable 63-bit-safe hash of the service name, used as the advisory lock key. */
function lockKey(serviceName: string): number {
  let h = 0;
  for (let i = 0; i < serviceName.length; i++) {
    h = (Math.imul(31, h) + serviceName.charCodeAt(i)) | 0;
  }
  return h;
}

export interface SingletonHandle {
  /** Releases the lock and closes its connection. Exiting does this anyway. */
  release: () => Promise<void>;
}

/**
 * Take the singleton lock for `serviceName`, or throw if another instance holds
 * it. Call once at startup, before connecting to any upstream feed.
 */
export async function acquireSingletonLock(
  serviceName: string,
  url = process.env.DATABASE_URL,
): Promise<SingletonHandle> {
  if (!url) throw new Error("DATABASE_URL is not set");

  // Dedicated connection: the lock lives as long as this session does.
  const holder = postgres(url, {
    max: 1,
    connection: { application_name: `${serviceName}:singleton-lock` },
  });

  const key = lockKey(serviceName);
  const [row] = await holder`select pg_try_advisory_lock(${key}) as locked`;

  if (!row?.locked) {
    // Report who has it, so the operator doesn't have to go digging.
    const others = await holder`
      select client_addr, application_name, backend_start
      from pg_stat_activity
      where datname = current_database()
        and application_name like ${serviceName + "%"}
        and pid <> pg_backend_pid()
      order by backend_start
      limit 5`;
    await holder.end({ timeout: 5 });

    const who = others
      .map((o) => `${o.application_name} from ${o.client_addr ?? "local"} since ${o.backend_start}`)
      .join("; ");
    throw new Error(
      `another ${serviceName} instance is already running against this database` +
        (who ? ` (${who})` : "") +
        `. Two instances would overwrite each other's writes — refusing to start.`,
    );
  }

  return {
    release: async () => {
      try {
        await holder`select pg_advisory_unlock(${key})`;
      } finally {
        await holder.end({ timeout: 5 });
      }
    },
  };
}
