import { Kafka, logLevel } from "kafkajs";

/**
 * Kafka client for the RDG Rail Data Marketplace Darwin feed.
 * RDM delivers Darwin via Confluent Cloud: SASL_SSL + PLAIN, using the
 * subscription's consumer key (username) and secret (password).
 */
export function createKafka(): Kafka {
  const brokers = (process.env.RDM_KAFKA_BOOTSTRAP_SERVERS ?? "").split(",").filter(Boolean);
  const username = process.env.RDM_CONSUMER_KEY;
  const password = process.env.RDM_CONSUMER_SECRET;
  if (brokers.length === 0 || !username || !password) {
    throw new Error(
      "RDM Kafka env not set (RDM_KAFKA_BOOTSTRAP_SERVERS, RDM_CONSUMER_KEY, RDM_CONSUMER_SECRET)",
    );
  }

  return new Kafka({
    clientId: "signaller-darwin-ingest",
    brokers,
    ssl: true,
    sasl: { mechanism: "plain", username, password },
    logLevel: logLevel.ERROR,
    retry: { retries: 8, initialRetryTime: 500 },
  });
}

export function kafkaTopic(): string {
  const topic = process.env.RDM_KAFKA_TOPIC;
  if (!topic) throw new Error("RDM_KAFKA_TOPIC is not set");
  return topic;
}
