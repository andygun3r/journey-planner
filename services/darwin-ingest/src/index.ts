import { acquireSingletonLock } from "@mainline/db";
import { Redis } from "ioredis";
import cron from "node-cron";
import { invalidateTrackedUids, matchCancellation, matchDelay } from "./alerts.js";
import { createKafka, kafkaTopic } from "./kafka.js";
import { pruneExpiredData } from "./maintenance.js";
import { corridorsEmptyForToday, precomputeAllCorridors } from "./precompute.js";
import { parseMessage } from "./pushport.js";
import {
  applyDeactivation,
  applyFormation,
  applyLoading,
  applySchedule,
  applyTS,
} from "./store.js";

/**
 * Darwin ingester: consume the RDM Push Port v18 feed, upsert train/forecast
 * state into Postgres, and publish per-station + per-rid deltas to Redis for
 * the SSE live-update layer. This is the deep feed powering journey-wide live
 * status and (later) commute alerts; LDBWS remains the board's primary source.
 */

const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl) : null;
if (!redis) console.warn("REDIS_URL not set — running without live pub/sub");

const groupId =
  process.env.RDM_KAFKA_GROUP_ID ?? process.env.RDM_CONSUMER_KEY ?? "mainline-darwin";

// Created in main(); kept module-scoped so shutdown() can disconnect it. This
// stays null on the --precompute-now path, which must not require Kafka env.
let consumer: ReturnType<ReturnType<typeof createKafka>["consumer"]> | null = null;

let processed = 0;
/** Messages whose handler threw. Their offsets still advanced — see the catch. */
let failed = 0;
let lastLog = Date.now();

async function handle(value: string): Promise<void> {
  for (const update of parseMessage(value)) {
    if (update.kind === "TS") {
      const touchedCrs = await applyTS(update);
      if (redis) {
        for (const crs of touchedCrs) {
          await redis.publish(`darwin:station:${crs}`, update.rid);
        }
        await redis.publish(`darwin:rid:${update.rid}`, "ts");
      }
      // Commute alerting is best-effort; never let it break ingestion.
      await matchDelay(update, redis).catch((err) =>
        console.error("[alerts] delay match error:", (err as Error).message),
      );
    } else if (update.kind === "schedule") {
      await applySchedule(update);
      if (redis && update.cancelled) {
        await redis.publish(`darwin:rid:${update.rid}`, "cancelled");
      }
      await matchCancellation(update, redis).catch((err) =>
        console.error("[alerts] cancellation match error:", (err as Error).message),
      );
    } else if (update.kind === "deactivated") {
      await applyDeactivation(update);
    } else if (update.kind === "formation") {
      await applyFormation(update);
    } else if (update.kind === "loading") {
      await applyLoading(update);
      if (redis) await redis.publish(`darwin:rid:${update.rid}`, "loading");
    }
    processed++;
  }

  if (Date.now() - lastLog > 15_000) {
    console.log(
      `[darwin] processed ${processed} updates` + (failed > 0 ? `, ${failed} failed` : ""),
    );
    lastLog = Date.now();
  }
}

/**
 * Expire daily data (see pruneExpiredData). Deliberately NOT inside
 * scheduleCorridorPrecompute: that returns early when MOTIS_URL is unset, which
 * would silently disable pruning on any deployment without MOTIS and let the
 * tables grow without bound. Data lifecycle must not depend on the routing
 * engine being configured.
 *
 * 03:30 — an hour after the corridor precompute, and AFTER it, because the
 * precompute reads yesterday's schedules that this deletes.
 */
function scheduleMaintenance(): void {
  cron.schedule("30 3 * * *", () => {
    void pruneExpiredData().catch((err) =>
      console.error("[maintenance] nightly prune failed:", (err as Error).message),
    );
  });
}

/**
 * Schedules the nightly commute-corridor precompute and runs it once on boot if
 * today's corridors are missing. Isolated in its own try/catch so it can never
 * take down the Kafka consumer — a MOTIS outage just leaves yesterday's rows.
 */
function scheduleCorridorPrecompute(): void {
  if (!process.env.MOTIS_URL) {
    console.warn("[precompute] MOTIS_URL not set — commute corridor precompute disabled");
    return;
  }

  cron.schedule("30 2 * * *", () => {
    void precomputeAllCorridors()
      .then(() => invalidateTrackedUids())
      .catch((err) => console.error("[precompute] nightly run failed:", (err as Error).message));
  });


  // Boot-time catch-up: if today has no corridors yet, compute them now.
  void (async () => {
    try {
      if (await corridorsEmptyForToday()) {
        console.log("[precompute] no corridors for today — running boot-time precompute");
        await precomputeAllCorridors();
        invalidateTrackedUids();
      }
    } catch (err) {
      console.error("[precompute] boot-time run failed:", (err as Error).message);
    }
  })();
}

async function main(): Promise<void> {
  scheduleCorridorPrecompute();
  scheduleMaintenance();

  consumer = createKafka().consumer({ groupId });

  // KafkaJS emits CRASH as an event, not a rejection of consumer.run()'s
  // promise — without this listener the process stayed alive (and Docker's
  // `restart: unless-stopped` never fired) after an unrecoverable error like
  // a SASL auth timeout, silently leaving the consumer dead while the
  // container reported healthy (the healthcheck only checks the process is
  // running, not that it's making progress). Exit and let Docker restart us.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    console.error("[darwin] consumer crashed:", payload.error);
    process.exit(1);
  });

  await consumer.connect();
  await consumer.subscribe({ topic: kafkaTopic(), fromBeginning: false });
  console.log(`[darwin] consuming ${kafkaTopic()} as group ${groupId}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString("utf8");
      if (value) {
        try {
          await handle(value);
        } catch (err) {
          // Swallowing this keeps the consumer moving, but the offset still
          // advances — so a message that always fails is skipped for good.
          // That is a deliberate trade (one bad message must not wedge the
          // feed), but it was previously invisible: count the failures so a
          // systematic parse or write problem shows up as a number instead of
          // scrolling past in the logs.
          failed++;
          console.error("[darwin] handle error:", (err as Error).message);
        }
      }
    },
  });
}

async function shutdown(): Promise<void> {
  console.log("[darwin] shutting down…");
  try {
    await consumer?.disconnect();
  } catch {
    /* ignore */
  }
  redis?.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// `--precompute-now`: run the corridor precompute once and exit (no Kafka).
// Handy for verifying corridors locally without the live feed.
if (process.argv.includes("--precompute-now")) {
  precomputeAllCorridors()
    .then(() => {
      console.log("[precompute] one-shot complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[precompute] one-shot failed:", err);
      process.exit(1);
    });
} else {
  // Exactly-one-writer, same as nr-ingest: two live consumers on one database
  // overwrite each other's rows rather than sharing the work. The one-shot
  // precompute above is exempt.
  //
  // The two failures are reported separately on purpose: chaining .then(main)
  // into a single .catch made every startup error inside main() print as
  // "another instance is already running", which is actively misleading — and
  // on a restarting container it looks like a self-deadlock.
  acquireSingletonLock("darwin-ingest").then(
    () =>
      main().catch((err) => {
        console.error("[darwin] fatal:", err);
        process.exit(1);
      }),
    (err) => {
      console.error(`[darwin] ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
