import { connect, nrConfig, TOPICS } from "./stomp.js";

/**
 * Connection + shape probe. Confirms your Network Rail credentials work and
 * prints the first few Train Movements and Train Describer messages so we can
 * model the real wire format before building the ingester.
 *
 * Run: NETWORKRAIL_USERNAME=... NETWORKRAIL_PASSWORD=... pnpm --filter @signaller/nr-ingest probe
 */

const cfg = nrConfig();
console.log(`Connecting to ${cfg.host}:${cfg.port} as ${cfg.login}…`);

const client = await connect(cfg);
console.log("✓ Connected & authenticated.");

const captured: Record<string, number> = {};
const shown: Record<string, boolean> = {};

function subscribe(name: string, topic: string, max = 2) {
  client.subscribe(
    { destination: topic, ack: "auto", "activemq.subscriptionName": `${cfg.clientId}-${name}` },
    (err, message) => {
      if (err) {
        console.error(`✗ ${name} (${topic}): ${err.message}`);
        return;
      }
      message.readString("utf-8", (readErr: Error | null, body?: string) => {
        if (readErr || !body) return;
        captured[name] = (captured[name] ?? 0) + 1;
        if (!shown[name]) {
          shown[name] = true;
          console.log(`\n===== first ${name} message (${topic}) =====`);
          try {
            console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 3000));
          } catch {
            console.log(body.slice(0, 2000));
          }
        }
        if (captured[name]! >= max && captured[name] === max) {
          console.log(`(${name}: seen ${captured[name]} messages)`);
        }
      });
    },
  );
  console.log(`Subscribed to ${name} (${topic})`);
}

subscribe("movements", TOPICS.trainMovements);
subscribe("td", TOPICS.trainDescriber);

setTimeout(() => {
  console.log("\nSummary:", JSON.stringify(captured));
  console.log(
    captured.movements || captured.td
      ? "✓ Feeds are flowing."
      : "✗ Connected but no messages — check you SUBSCRIBED to these feeds on the My Feeds page.",
  );
  client.disconnect();
  process.exit(0);
}, 30_000);
