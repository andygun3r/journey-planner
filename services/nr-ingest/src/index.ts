import { acquireSingletonLock } from "@signaller/db";
import { parseRtppm, parseTsr, parseVstp } from "./parse-feeds.js";
import { parseMovements, parseSClass, parseTd } from "./parse.js";
import { loadSop } from "./load-sop.js";
import { loadCorpus, loadHeadcodes, loadSmart } from "./reference.js";
import { syncReferenceFromSftp } from "./reference-sftp.js";
import { applyRtppm, applyTsr, applyVstp } from "./store-feeds.js";
import {
  applyActivation,
  applyBerthStep,
  applyMovement,
  applySClass,
  flushHistory,
} from "./store.js";
import { beat } from "./heartbeat.js";
import { closePublisher, publishCrs } from "./publish.js";
import { connect, nrConfig, TOPICS } from "./stomp.js";
import { createTdKafka, tdKafkaConfigured, tdKafkaGroupId, tdKafkaTopic, type TdKafkaConsumer } from "./kafka.js";
import { startServer } from "./server.js";

/**
 * Network Rail ingester: consumes TRUST movements over Network Rail STOMP and
 * Train Describer over either Network Rail STOMP or RailData Kafka,
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
 *   (default)   run the live ingester. Also starts the internal HTTP server
 *               (see server.ts) when HTTP_PORT is set, so `web`/etl-cron —
 *               separate Coolify apps now, with no shared Docker socket —
 *               can trigger POST /reference-sftp instead of `docker exec`ing
 *               into a sibling container by name.
 *   reference   download + load CORPUS + SMART, then exit
 *   reference-sftp
 *               pull SMARTExtract.*.gz and TPS_Data.tar.gz from RDG SFTP,
 *               process them, delete successfully processed remote files
 *   headcodes   download + load the SCHEDULE feed's uid->headcode map, then
 *               exit — a much larger, slower download (~127MB gzipped) than
 *               `reference`, so it's kept as its own opt-in command rather
 *               than folded into routine reference refreshes.
 *   sop         load SOP/ECS signalling bit-maps from data/sop/, then exit
 */


let processed = 0;
let lastLog = Date.now();

async function runReference(): Promise<void> {
  console.log("[nr] loading reference data (CORPUS + SMART)…");
  await loadCorpus();
  await loadSmart();
  console.log("[nr] reference load complete.");
}

type StompClient = Awaited<ReturnType<typeof connect>>;

/**
 * How many unacknowledged messages the broker may have outstanding per
 * subscription. Small enough to bound in-flight work, large enough that the
 * consumer is never idle waiting for the next frame.
 */
const PREFETCH = Number(process.env.NR_STOMP_PREFETCH ?? 100);

function subscribeOn(
  client: StompClient,
  clientId: string,
  name: string,
  topic: string,
  handler: (body: string) => Promise<void>,
) {
  client.subscribe(
    {
      destination: topic,
      ack: "client-individual",
      "activemq.subscriptionName": `${clientId}-${name}`,
      // Cap how far ahead the broker may run.
      //
      // The ack below already happens after the handler resolves, which looks
      // like backpressure — but ActiveMQ's default topic prefetch is around
      // 32,000 messages, so it ships that many regardless and every one in
      // flight holds a promise chain and its own database work. On the TD feed
      // (thousands of messages a minute) that is how a slow moment turns into
      // unbounded memory growth. With a small prefetch the existing ack
      // becomes real flow control.
      "activemq.prefetchSize": String(PREFETCH),
    },
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
let tdKafkaStarted = false;
let activeClient: StompClient | null = null;
let activeTdKafkaConsumer: TdKafkaConsumer | null = null;
/** Bumped whenever a client is retired, so its late events can be ignored. */
let clientGeneration = 0;

async function handleMovementFrame(body: string): Promise<void> {
  for (const ev of parseMovements(body)) {
    if (ev.kind === "movement") {
      const crs = await applyMovement(ev);
      // Position updates are published from inside the store, so they cover
      // reports that never resolve to a station. This CRS-keyed one stays for
      // consumers that watch a station rather than a train.
      if (crs) publishCrs(crs, ev.trainId);
      processed++;
    } else if (ev.kind === "activation") {
      await applyActivation(ev.trainId, ev.trainUid, ev.scheduleStartDate, ev.originStanox);
    }
  }
}

async function handleTdFrame(body: string): Promise<void> {
  // The TD stream carries both C-class (berth steps) and S-class (signalling
  // state) messages; each parser ignores the other's message types.
  for (const step of parseTd(body)) {
    const crs = await applyBerthStep(step);
    if (crs) publishCrs(crs, step.headcode);
    processed++;
  }
  await applySClass(parseSClass(body));
}

async function runTdKafka(): Promise<void> {
  const topic = tdKafkaTopic();
  const groupId = tdKafkaGroupId();
  const consumer = createTdKafka().consumer({ groupId });
  activeTdKafkaConsumer = consumer;

  consumer.on(consumer.events.CRASH, ({ payload }) => {
    console.error("[nr] TD Kafka consumer crashed:", payload.error);
    process.exit(1);
  });

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  console.log(`[nr] consuming TD Kafka topic ${topic} as group ${groupId}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString("utf8");
      if (!value) return;
      try {
        await handleTdFrame(value);
      } catch (err) {
        console.error("[nr] td-kafka handler:", (err as Error).message);
      } finally {
        maybeLog();
      }
    },
  });
}

function installShutdown(): void {
  let shuttingDown = false;
  const shutdown = async () => {
    // A second signal while the flush is in flight must not cut it short.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[nr] shutting down…");
    try {
      activeClient?.disconnect();
      await activeTdKafkaConsumer?.disconnect();
    } catch {
      /* ignore */
    }
    // Position history is buffered, so anything still queued has to be written
    // before exiting or it is simply lost. Bounded by the flush size, so this
    // is one statement, not a long wait.
    await flushHistory().catch(() => {});
    closePublisher();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Reconnect the positioning stream after a dropped socket, with backoff.
 *
 * Tears the old client down first. Previously it didn't: runIngest() simply
 * overwrote `activeClient`, and `disconnect()` appeared only in the shutdown
 * handler. A socket that STOMP reported as errored but that was still
 * delivering frames therefore stayed subscribed alongside its replacement, so
 * the process would consume two streams at once and leak a connection per
 * reconnect. The generation counter additionally stops a retired client's late
 * `error` event from tearing down the healthy client that replaced it.
 */
function scheduleReconnect(reason: string): void {
  if (reconnecting) return;
  reconnecting = true;
  console.error(`[nr] positioning connection lost (${reason}); reconnecting in 10s.`);

  // Retire the current client immediately: bump the generation so its late
  // error events are ignored, and close the socket so it stops delivering.
  clientGeneration++;
  try {
    activeClient?.disconnect();
  } catch {
    /* already dead; nothing to clean up */
  }
  activeClient = null;

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
  // Stamped with the generation this client belongs to: a client retired by a
  // previous scheduleReconnect can still emit errors, and acting on those
  // would tear down the healthy replacement that succeeded it.
  const generation = clientGeneration;
  client.on("error", (err: Error) => {
    if (generation !== clientGeneration) return;
    scheduleReconnect(err.message);
  });

  const subscribe = (name: string, topic: string, handler: (body: string) => Promise<void>) =>
    subscribeOn(client, cfg.clientId, name, topic, handler);

  subscribe("movements", TOPICS.trainMovements, handleMovementFrame);

  if (tdKafkaConfigured()) {
    if (!tdKafkaStarted) {
      tdKafkaStarted = true;
      console.log("[nr] TD Kafka env detected; consuming Train Describer from RailData Kafka.");
      void runTdKafka().catch((err) => {
        console.error("[nr] td-kafka fatal:", err);
        process.exit(1);
      });
    }
  } else {
    subscribe("td", TOPICS.trainDescriber, handleTdFrame);
  }

  // Start the non-positioning feeds on their own connection, once (a
  // positioning reconnect must not spawn a second extra-feeds connection).
  if (!extraFeedsStarted) {
    extraFeedsStarted = true;
    void runExtraFeeds();
  }

  // Track the current client so the (once-registered) shutdown handler always
  // closes the live one after a reconnect. If a reconnect was scheduled while
  // we were awaiting connect() above, this client is already stale on arrival —
  // close it rather than installing it, or it becomes exactly the orphaned
  // second subscription this generation counter exists to prevent.
  if (generation !== clientGeneration) {
    try {
      client.disconnect();
    } catch {
      /* nothing to clean up */
    }
    return;
  }
  activeClient = client;
}

function maybeLog() {
  // Called after every handled frame, so this is also the natural place to
  // record that the consumer is genuinely still consuming — see heartbeat.ts.
  beat();
  if (Date.now() - lastLog > 15_000) {
    console.log(`[nr] processed ${processed} position updates`);
    lastLog = Date.now();
  }
}

const command = process.argv[2];
if (command === "reference") {
  await runReference();
  process.exit(0);
} else if (command === "headcodes") {
  console.log("[nr] loading uid->headcode map from SCHEDULE (this can take a few minutes)…");
  await loadHeadcodes();
  process.exit(0);
} else if (command === "reference-sftp") {
  console.log("[nr] syncing reference files from SFTP…");
  await syncReferenceFromSftp();
  process.exit(0);
} else if (command === "sop") {
  console.log("[nr] loading SOP signalling bit-maps…");
  await loadSop();
  process.exit(0);
} else {
  // Exactly-one-writer: a second live ingester on the same database doesn't
  // share the work, it overwrites it (see acquireSingletonLock's comment for
  // the incident this prevents). The one-shot sub-commands above are exempt —
  // they're idempotent loaders, safe to run while the ingester is up.
  try {
    await acquireSingletonLock("nr-ingest");
  } catch (e) {
    console.error(`[nr] ${(e as Error).message}`);
    process.exit(1);
  }
  installShutdown();
  const httpPort = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : undefined;
  if (httpPort) startServer(httpPort);
  await runIngest();
}
