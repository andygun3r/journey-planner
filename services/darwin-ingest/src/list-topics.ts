import { createKafka } from "./kafka.js";

/** List the topics these RDM credentials are actually allowed to see. */
const admin = createKafka().admin();
await admin.connect();
try {
  const topics = await admin.listTopics();
  console.log("Accessible topics:");
  for (const t of topics) console.log("  -", t);
  if (topics.length === 0) console.log("  (none — the ACL may be per-topic and not list-visible)");
} finally {
  await admin.disconnect();
}
process.exit(0);
