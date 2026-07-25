import { Redis } from "ioredis";
import { parseRtppm, parseTsr, parseVstp } from "./parse-feeds.js";
import { parseMovements, parseTd } from "./parse.js";
import { loadCorpus, loadSmart } from "./reference.js";
import { applyRtppm, applyTsr, applyVstp } from "./store-feeds.js";
import { applyActivation, applyBerthStep, applyMovement } from "./store.js";
import { connect, nrConfig, TOPICS } from "./stomp.js";

/**
 * Network Rail ingester: consumes TRUST movements + Train Describer over STOMP,
 * translates STANOX/berths to CRS via CORPUS/SMART, and maintains live train
 * positions in Postgres (nr_train_position). Publishes CRS-keyed deltas to
 * Redis. This adds between-station positioning on top of Darwin.
 *
 * The remaining NR feeds (VSTP schedules, TSRs, RTPPM punctuality) run on a
 * SECOND connection: a feed the account hasn't subscribed to on the My Feeds
 * page makes the broker error the whole connection, and that must never take
 * down positioning.
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

type StompClient = Awaited<ReturnType<typeof connect>>;

function subscribeOn(
  client: StompClient,
  clientId: string,
  name: string,
  topic: string,
  handler: (body: string) => Promise<void>,
) {
  client.subscribe(
    { destination: topic, ack: "client-individual", "activemq.subscriptionName": `${clientId}-${name}` },
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

/**
 * VSTP + TSR + RTPPM on their own connection. If it errors (typically "not
 * authorized" because a feed isn't ticked on the My Feeds page), log a clear
 * pointer and retry with a long backoff — positioning is unaffected.
 */
async function runExtraFeeds(): Promise<void> {
  const cfg = nrConfig();
  const clientId = `${cfg.clientId}-feeds`;
  try {
    const client = await connect({ ...cfg, clientId });
    client.on("error", (err) => {
      console.error(
        `[nr] extra-feeds connection error: ${err.message} — if this says "not authorized", ` +
          "subscribe to VSTP/TSR/RTPPM on the My Feeds page at datafeeds.networkrail.co.uk. Retrying in 15 min.",
      );
      setTimeout(runExtraFeeds, 15 * 60_000);
    });

    subscribeOn(client, clientId, "vstp", TOPICS.vstp, async (body) => {
      for (const s of parseVstp(body)) await applyVstp(s);
    });
    subscribeOn(client, clientId, "tsr", TOPICS.tsr, async (body) => {
      for (const t of parseTsr(body)) await applyTsr(t);
    });
    subscribeOn(client, clientId, "rtppm", TOPICS.rtppm, async (body) => {
      for (const r of parseRtppm(body)) await applyRtppm(r);
    });
  } catch (e) {
    console.error(`[nr] extra-feeds connect failed: ${(e as Error).message}. Retrying in 15 min.`);
    setTimeout(runExtraFeeds, 15 * 60_000);
  }
}

let reconnecting = false;
let extraFeedsStarted = false;
let activeClient: StompClient | null = null;

function installShutdown(): void {
  const shutdown = () => {
    console.log("[nr] shutting down…");
    try {
      activeClient?.disconnect();
    } catch {
      /* ignore */
    }
    redis?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Reconnect the positioning stream after a dropped socket, with backoff. */
function scheduleReconnect(reason: string): void {
  if (reconnecting) return;
  reconnecting = true;
  console.error(`[nr] positioning connection lost (${reason}); reconnecting in 10s.`);
  setTimeout(() => {
    reconnecting = false;
    runIngest().catch((e) => {
      console.error(`[nr] reconnect failed: ${(e as Error).message}; retrying in 30s.`);
      setTimeout(() => scheduleReconnect("retry"), 30_000);
    });
  }, 10_000);
}

async function runIngest(): Promise<void> {
  const cfg = nrConfig();
  const client = await connect(cfg);
  console.log(`[nr] connected as ${cfg.login}`);

  // A dropped STOMP socket must not kill the process — reconnect instead.
  client.on("error", (err: Error) => scheduleReconnect(err.message));

  const subscribe = (name: string, topic: string, handler: (body: string) => Promise<void>) =>
    subscribeOn(client, cfg.clientId, name, topic, handler);

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

  // Start the non-positioning feeds on their own connection, once (a
  // positioning reconnect must not spawn a second extra-feeds connection).
  if (!extraFeedsStarted) {
    extraFeedsStarted = true;
    void runExtraFeeds();
  }

  // Track the current client so the (once-registered) shutdown handler always
  // closes the live one after a reconnect.
  activeClient = client;
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
  installShutdown();
  await runIngest();
}
