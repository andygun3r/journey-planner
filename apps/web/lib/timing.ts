/**
 * Minimal request timing.
 *
 * The app had no way to answer "which part of this was slow". A board request
 * fans out to LDBWS, several Postgres queries and sometimes MOTIS, and until
 * now all of that was one opaque wait. This records the pieces and hands them
 * back as a Server-Timing header, which browser dev tools show natively in the
 * network panel — no dashboard or extra service needed.
 *
 * Deliberately tiny. Timing must never cost more than the thing it measures.
 */

export interface Timer {
  /** Times a promise and records it under `label`. Returns the same value. */
  track<T>(label: string, work: Promise<T>): Promise<T>;
  /** Records a duration measured elsewhere. */
  record(label: string, ms: number): void;
  /** Server-Timing header value, or null when nothing was recorded. */
  header(): string | null;
  /** Total elapsed since the timer was created. */
  elapsed(): number;
}

/**
 * Times `work` when a timer was supplied, and gets out of the way when it
 * wasn't. Lets library code be instrumented without forcing every caller to
 * care about timing.
 */
export function track<T>(timer: Timer | undefined, label: string, work: Promise<T>): Promise<T> {
  return timer ? timer.track(label, work) : work;
}

export function startTimer(): Timer {
  const startedAt = Date.now();
  const marks: Array<[string, number]> = [];

  return {
    async track<T>(label: string, work: Promise<T>): Promise<T> {
      const at = Date.now();
      try {
        return await work;
      } finally {
        marks.push([label, Date.now() - at]);
      }
    },
    record(label: string, ms: number) {
      marks.push([label, ms]);
    },
    header() {
      if (marks.length === 0) return null;
      const parts = marks.map(
        // Server-Timing names allow no spaces or commas.
        ([label, ms]) => `${label.replace(/[^a-zA-Z0-9_-]/g, "_")};dur=${ms}`,
      );
      parts.push(`total;dur=${Date.now() - startedAt}`);
      return parts.join(", ");
    },
    elapsed() {
      return Date.now() - startedAt;
    },
  };
}
