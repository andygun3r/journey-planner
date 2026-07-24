import { createKafka, kafkaTopic } from "./kafka.js";

/**
 * One-off: connect to the RDM Darwin topic, print the first few raw messages
 * so we can model the real Push Port JSON envelope before writing the parser.
 * Run: pnpm --filter @mainline/darwin-ingest probe
 */
const kafka = createKafka();
// RDM restricts the consumer group id. Convention: the group must equal (or be
// prefixed by) the consumer key. Overridable via RDM_KAFKA_GROUP_ID.
const groupId = process.env.RDM_KAFKA_GROUP_ID ?? process.env.RDM_CONSUMER_KEY ?? "mainline";
console.log(`Using consumer group: ${groupId}`);
const consumer = kafka.consumer({ groupId });

let seen = 0;
const MAX = 5;

await consumer.connect();
await consumer.subscribe({ topic: kafkaTopic(), fromBeginning: false });
console.log("Connected. Waiting for messages…");

await consumer.run({
  eachMessage: async ({ message }) => {
    seen++;
    const value = message.value?.toString("utf8") ?? "";
    console.log(`\n===== message ${seen} (key=${message.key?.toString() ?? "-"}) =====`);
    try {
      console.log(JSON.stringify(JSON.parse(value), null, 2).slice(0, 4000));
    } catch {
      console.log(value.slice(0, 2000));
    }
    if (seen >= MAX) {
      await consumer.disconnect();
      process.exit(0);
    }
  },
});

setTimeout(() => {
  console.error("No messages within 60s — check topic name / credentials / feed activity.");
  process.exit(1);
}, 60_000);
