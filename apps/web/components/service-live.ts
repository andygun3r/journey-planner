"use client";

import { useEffect, useState } from "react";
import type { MapTrain } from "./map-types";

/**
 * One EventSource per service page, shared by everything on it.
 *
 * The page has two live islands in different parts of the DOM — the position
 * map and the "updated Ns ago" refresher — and they are separate React trees,
 * so neither can hold the connection for the other. Without this each would
 * open its own stream for the same rid, which is exactly the duplication this
 * work is meant to remove, just moved from the server to the browser.
 *
 * Reference-counted the same way the server side is: the first subscriber
 * opens the stream, the last one to leave closes it.
 */

export type ServicePosition = MapTrain | null;

type Listener = (position: ServicePosition) => void;

interface Connection {
  listeners: Set<Listener>;
  es: EventSource | null;
  /** The last position seen, handed to anyone joining mid-flight. */
  latest: ServicePosition | undefined;
  /** True once the server has said the stream is live. */
  ready: boolean;
  attempt: number;
  reconnect: ReturnType<typeof setTimeout> | undefined;
  /** Set when the server says it has no Redis: never try the stream again. */
  unavailable: boolean;
  closed: boolean;
}

const connections = new Map<string, Connection>();

function open(rid: string, connection: Connection): void {
  if (connection.closed || connection.unavailable) return;
  if (typeof window === "undefined" || !("EventSource" in window)) {
    connection.unavailable = true;
    return;
  }

  const es = new EventSource(`/api/live/service?rid=${encodeURIComponent(rid)}`);
  connection.es = es;

  es.addEventListener("ready", () => {
    connection.attempt = 0;
    connection.ready = true;
  });

  es.addEventListener("unavailable", () => {
    // No Redis on the server. Retrying cannot help, so let the subscribers fall
    // back to polling for good.
    connection.unavailable = true;
    es.close();
    connection.es = null;
  });

  es.addEventListener("position", (ev) => {
    const position = JSON.parse((ev as MessageEvent<string>).data) as ServicePosition;
    connection.latest = position;
    connection.ready = true;
    for (const listener of connection.listeners) {
      try {
        listener(position);
      } catch {
        // One broken subscriber must not stop the others being served.
      }
    }
  });

  es.onerror = () => {
    es.close();
    connection.es = null;
    connection.ready = false;
    if (connection.closed) return;
    connection.attempt += 1;
    connection.reconnect = setTimeout(
      () => open(rid, connection),
      Math.min(1000 * 2 ** connection.attempt, 60_000),
    );
  };
}

function subscribe(rid: string, listener: Listener): () => void {
  let connection = connections.get(rid);
  if (!connection) {
    connection = {
      listeners: new Set(),
      es: null,
      latest: undefined,
      ready: false,
      attempt: 0,
      reconnect: undefined,
      unavailable: false,
      closed: false,
    };
    connections.set(rid, connection);
    open(rid, connection);
  }

  connection.listeners.add(listener);
  if (connection.latest !== undefined) listener(connection.latest);

  const active = connection;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.listeners.delete(listener);
    if (active.listeners.size > 0) return;
    active.closed = true;
    active.es?.close();
    if (active.reconnect) clearTimeout(active.reconnect);
    connections.delete(rid);
  };
}

/** Whether the stream is carrying data, so a caller knows to stop polling. */
export function isStreaming(rid: string): boolean {
  const connection = connections.get(rid);
  return Boolean(connection?.ready && !connection.unavailable);
}

/**
 * Subscribe to a service's live position.
 *
 * `streaming` is false until the server confirms the stream, and goes back to
 * false if it drops — that is the signal for a caller to cover the gap by
 * polling.
 */
export function useServicePosition(rid: string): {
  position: ServicePosition | undefined;
  streaming: boolean;
} {
  const [position, setPosition] = useState<ServicePosition | undefined>(undefined);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    setPosition(undefined);
    const off = subscribe(rid, (next) => {
      setPosition(next);
      setStreaming(true);
    });
    // The `ready` event can land before the first position; poll the shared
    // connection briefly so a quiet service still stands its poll down.
    const check = setInterval(() => setStreaming(isStreaming(rid)), 1000);
    return () => {
      off();
      clearInterval(check);
      setStreaming(false);
    };
  }, [rid]);

  return { position, streaming };
}
