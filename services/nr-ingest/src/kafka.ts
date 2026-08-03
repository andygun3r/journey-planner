import { Kafka, logLevel, type Consumer } from "kafkajs";

/**
 * Kafka client for RailData's Network Rail Train Describer product.
 * The product is hosted on Confluent Cloud: SASL_SSL + PLAIN.
 */

export function tdKafkaConfigured(): boolean {
  return Boolean(process.env.NR_TD_KAFKA_BOOTSTRAP_SERVERS || process.env.RDM_TD_KAFKA_BOOTSTRAP_SERVERS);
}

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] || (fallback ? process.env[fallback] : undefined);
}

function requireEnv(name: string, fallback?: string): string {
  const value = env(name, fallback);
  if (!value) throw new Error(`${name}${fallback ? ` / ${fallback}` : ""} is not set`);
  return value;
}

export function createTdKafka(): Kafka {
  const brokers = requireEnv("NR_TD_KAFKA_BOOTSTRAP_SERVERS", "RDM_TD_KAFKA_BOOTSTRAP_SERVERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const username = requireEnv("NR_TD_KAFKA_USERNAME", "RDM_TD_CONSUMER_KEY");
  const password = requireEnv("NR_TD_KAFKA_PASSWORD", "RDM_TD_CONSUMER_SECRET");
  if (brokers.length === 0) throw new Error("NR_TD_KAFKA_BOOTSTRAP_SERVERS contains no brokers");

  return new Kafka({
    clientId: process.env.NR_TD_KAFKA_CLIENT_ID ?? "mainline-nr-td-ingest",
    brokers,
    ssl: true,
    sasl: { mechanism: "plain", username, password },
    logLevel: logLevel.ERROR,
    retry: { retries: 8, initialRetryTime: 500 },
  });
}

export function tdKafkaTopic(): string {
  return process.env.NR_TD_KAFKA_TOPIC ?? process.env.RDM_TD_KAFKA_TOPIC ?? "TD_ALL_SIG_AREA";
}

export function tdKafkaGroupId(): string {
  return process.env.NR_TD_KAFKA_GROUP_ID ?? "mainline-nr-td-ingest";
}

export type TdKafkaConsumer = Consumer;
