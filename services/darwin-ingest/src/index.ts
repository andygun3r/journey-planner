import { Redis } from "ioredis";
import { createKafka, kafkaTopic } from "./kafka.js";
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

const kafka = createKafka();
const groupId =
  process.env.RDM_KAFKA_GROUP_ID ?? process.env.RDM_CONSUMER_KEY ?? "mainline-darwin";
const consumer = kafka.consumer({ groupId });

let processed = 0;
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
    } else if (update.kind === "schedule") {
      await applySchedule(update);
      if (redis && update.cancelled) {
        await redis.publish(`darwin:rid:${update.rid}`, "cancelled");
      }
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
    console.log(`[darwin] processed ${processed} updates`);
    lastLog = Date.now();
  }
}

async function main(): Promise<void> {
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
          console.error("[darwin] handle error:", (err as Error).message);
        }
      }
    },
  });
}

async function shutdown(): Promise<void> {
  console.log("[darwin] shutting down…");
  try {
    await consumer.disconnect();
  } catch {
    /* ignore */
  }
  redis?.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[darwin] fatal:", err);
  process.exit(1);
});
