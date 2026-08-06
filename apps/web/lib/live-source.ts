import { psubscribe, subscribe } from "./live-bus";

/**
 * One computation shared by every viewer of the same thing.
 *
 * This is the point of the whole exercise. Today each viewer independently
 * triggers a full recompute: fifty people watching the map means fifty runs of a
 * query returning tens of thousands of rows, all producing an identical answer.
 * A live source computes once per tick, however many people are watching, and
 * hands the same result to all of them.
 *
 * Sources are reference-counted like the Redis subscriptions underneath them —
 * the first subscriber starts the work, the last one to leave stops it. Nothing
 * runs when nobody is looking.
 *
 * Two things worth understanding before using this:
 *
 * **The interval is not a fallback, it is the floor.** Some sources change with
 * the clock rather than with events — a departed train slides along its leg
 * whether or not anything was published — so those must tick regardless. Events
 * pull the next recompute earlier; they do not replace it.
 *
 * **Triggers are debounced, deliberately.** A busy station publishes several
 * times a second. Recomputing per event would be worse than the polling this
 * replaces, so an event schedules a run soon rather than now.
 */

export type Unsubscribe = () => void;

export interface LiveSourceOptions<T> {
  /** Stable identity. Two subscribers with the same key share everything. */
  key: string;
  /** Produces a fresh snapshot. Runs at most once at a time per key. */
  compute: () => Promise<T>;
  /** The floor: recompute at least this often while anyone is subscribed. */
  intervalMs: number;
  /** Redis channels whose messages should pull the next recompute forward. */
  channels?: string[];
  /** Redis glob patterns, same effect. Prefer channels where the set is known. */
  patterns?: string[];
  /**
   * How long to wait after a trigger before recomputing. Coalesces a burst into
   * one run; also caps how often events can drive work.
   */
  debounceMs?: number;
}

type Subscriber<T> = (snapshot: T) => void;

interface Source<T> {
  subscribers: Set<Subscriber<T>>;
  /** The most recent snapshot, handed to anyone who joins mid-flight. */
  latest: T | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
  debounce: ReturnType<typeof setTimeout> | undefined;
  unsubscribers: Unsubscribe[];
  /** True while a compute is in flight, so triggers cannot pile up behind it. */
  running: boolean;
  /** A trigger that arrived during a run, so we recompute once afterwards. */
  pending: boolean;
  options: LiveSourceOptions<T>;
  computes: number;
}

// On globalThis for the same reason live-bus is: Next reloads modules in
// development, and a plain module variable would leak a timer per reload.
const globalForSources = globalThis as unknown as {
  __signallerLiveSources?: Map<string, Source<unknown>>;
};

function sources(): Map<string, Source<unknown>> {
  globalForSources.__signallerLiveSources ??= new Map();
  return globalForSources.__signallerLiveSources;
}

async function run<T>(source: Source<T>): Promise<void> {
  if (source.running) {
    // Something asked while we were already working. Note it and fold it into
    // one extra run at the end rather than queueing another compute.
    source.pending = true;
    return;
  }
  source.running = true;
  try {
    const snapshot = await source.options.compute();
    source.latest = snapshot;
    source.computes += 1;
    for (const subscriber of source.subscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // One broken stream must not stop the others being served.
      }
    }
  } catch {
    // A failed compute keeps the previous snapshot. Subscribers would rather
    // hold slightly stale data than be told nothing at all, and the next tick
    // will try again.
  } finally {
    source.running = false;
    if (source.pending) {
      source.pending = false;
      void run(source);
    }
  }
}

function schedule<T>(source: Source<T>): void {
  if (source.debounce) return; // already scheduled; nothing to add
  source.debounce = setTimeout(() => {
    source.debounce = undefined;
    void run(source);
  }, source.options.debounceMs ?? 500);
}

function stop(key: string, source: Source<unknown>): void {
  if (source.timer) clearInterval(source.timer);
  if (source.debounce) clearTimeout(source.debounce);
  for (const off of source.unsubscribers) off();
  sources().delete(key);
}

/**
 * Subscribe to a shared source, creating it if this is the first subscriber.
 *
 * The callback fires with the current snapshot immediately when one exists, so a
 * viewer joining an established stream doesn't wait for the next tick.
 */
export function subscribeToSource<T>(
  options: LiveSourceOptions<T>,
  onSnapshot: Subscriber<T>,
): Unsubscribe {
  const all = sources();
  let source = all.get(options.key) as Source<T> | undefined;

  if (!source) {
    source = {
      subscribers: new Set(),
      latest: undefined,
      timer: undefined,
      debounce: undefined,
      unsubscribers: [],
      running: false,
      pending: false,
      options,
      computes: 0,
    };
    all.set(options.key, source as Source<unknown>);

    const created = source;
    for (const channel of options.channels ?? []) {
      created.unsubscribers.push(subscribe(channel, () => schedule(created)));
    }
    for (const pattern of options.patterns ?? []) {
      created.unsubscribers.push(psubscribe(pattern, () => schedule(created)));
    }
    created.timer = setInterval(() => void run(created), options.intervalMs);
    // Don't make the first viewer wait for a whole interval.
    void run(created);
  }

  source.subscribers.add(onSnapshot);
  if (source.latest !== undefined) {
    try {
      onSnapshot(source.latest);
    } catch {
      // Delivering the cached snapshot must not break the subscribe call.
    }
  }

  const active = source;
  let released = false;
  return () => {
    // Guard against a double release — a stream can be ended by both its abort
    // handler and its cancel callback.
    if (released) return;
    released = true;
    active.subscribers.delete(onSnapshot);
    if (active.subscribers.size === 0) stop(options.key, active as Source<unknown>);
  };
}

/**
 * What's running right now. Reported by /api/metrics so the fan-out is visible:
 * `subscribers` should grow with viewers while `sources` and the compute rate
 * stay flat. That difference is the whole point.
 */
export function sourceStats(): {
  sources: number;
  subscribers: number;
  computes: number;
} {
  let subscribers = 0;
  let computes = 0;
  for (const source of sources().values()) {
    subscribers += source.subscribers.size;
    computes += source.computes;
  }
  return { sources: sources().size, subscribers, computes };
}
