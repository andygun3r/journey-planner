import { Redis } from "ioredis";
import { parseMovements, parseTd } from "./parse.js";
import { loadCorpus, loadSmart } from "./reference.js";
import { applyActivation, applyBerthStep, applyMovement } from "./store.js";
import { connect, nrConfig, TOPICS } from "./stomp.js";

/**
 * Network Rail ingester: consumes TRUST movements + Train Describer over STOMP,
 * translates STANOX/berths to CRS via CORPUS/SMART, and maintains live train
 * positions in Postgres (nr_train_position). Publishes CRS-keyed deltas to
 * Redis. This adds between-station positioning on top of Darwin.
 *
 * Sub-commands:
 *   (default)  run the live ingester
 *   reference  download + load CORPUS + SMART, then exit
 */

const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl) : null;

let processed = 0;
let lastLog = Date.now();

async function runReference(): Promise<void> {
  console.log("[nr] loading reference data (CORPUS + SMART)…");
  await loadCorpus();
  await loadSmart();
  console.log("[nr] reference load complete.");
}

async function runIngest(): Promise<void> {
  const cfg = nrConfig();
  const client = await connect(cfg);
  console.log(`[nr] connected as ${cfg.login}`);

  function subscribe(name: string, topic: string, handler: (body: string) => Promise<void>) {
    client.subscribe(
      { destination: topic, ack: "client-individual", "activemq.subscriptionName": `${cfg.clientId}-${name}` },
      (err, message) => {
        if (err) {
          console.error(`[nr] subscribe ${name} error:`, err.message);
          return;
        }
        message.readString("utf-8", async (readErr: Error | null, body?: string) => {
          if (!readErr && body) {
            try {
              await handler(body);
            } catch (e) {
              console.error(`[nr] ${name} handler:`, (e as Error).message);
            }
          }
          client.ack(message);
          maybeLog();
        });
      },
    );
    console.log(`[nr] subscribed ${name} (${topic})`);
  }

  subscribe("movements", TOPICS.trainMovements, async (body) => {
    for (const ev of parseMovements(body)) {
      if (ev.kind === "movement") {
        const crs = await applyMovement(ev);
        if (redis && crs) await redis.publish(`nr:crs:${crs}`, ev.trainId);
        processed++;
      } else if (ev.kind === "activation") {
        await applyActivation(ev.trainId, ev.trainUid);
      }
    }
  });

  subscribe("td", TOPICS.trainDescriber, async (body) => {
    for (const step of parseTd(body)) {
      const crs = await applyBerthStep(step);
      if (redis && crs) await redis.publish(`nr:crs:${crs}`, step.headcode);
      processed++;
    }
  });

  const shutdown = () => {
    console.log("[nr] shutting down…");
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    redis?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function maybeLog() {
  if (Date.now() - lastLog > 15_000) {
    console.log(`[nr] processed ${processed} position updates`);
    lastLog = Date.now();
  }
}

const command = process.argv[2];
if (command === "reference") {
  await runReference();
  process.exit(0);
} else {
  await runIngest();
}
