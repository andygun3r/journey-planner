import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These lock in the behaviour that makes a shared source worth having: one
 * computation however many viewers, a burst of events collapsing into one run,
 * and the work stopping when the last viewer leaves. Each of those fails
 * silently if it regresses — you get correct data at the wrong cost.
 */

/** Captured trigger callbacks, so a test can fire a Redis event by hand. */
const triggers: Array<() => void> = [];
const unsubscribed: string[] = [];

vi.mock("./live-bus", () => ({
  subscribe: (channel: string, listener: () => void) => {
    triggers.push(listener);
    return () => unsubscribed.push(channel);
  },
  psubscribe: (pattern: string, listener: () => void) => {
    triggers.push(listener);
    return () => unsubscribed.push(pattern);
  },
}));

const { subscribeToSource, sourceStats } = await import("./live-source");

/**
 * Lets pending promise callbacks run between timer advances.
 *
 * Deliberately a microtask flush rather than setImmediate — fake timers control
 * setImmediate too, so waiting on one under useFakeTimers never resolves.
 */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let keySeq = 0;
const uniqueKey = () => `test-${keySeq++}`;

beforeEach(() => {
  vi.useFakeTimers();
  triggers.length = 0;
  unsubscribed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeToSource", () => {
  it("computes once for many subscribers, not once each", async () => {
    let computes = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => ++computes,
      intervalMs: 1000,
    };

    const seenA: number[] = [];
    const seenB: number[] = [];
    const offA = subscribeToSource(options, (n) => seenA.push(n));
    const offB = subscribeToSource(options, (n) => seenB.push(n));
    await settle();

    // One initial run, delivered to both.
    expect(computes).toBe(1);
    expect(seenA).toEqual([1]);
    expect(seenB).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(computes).toBe(2);

    offA();
    offB();
  });

  it("hands a late subscriber the snapshot it already has", async () => {
    const options = { key: uniqueKey(), compute: async () => "snapshot", intervalMs: 1000 };
    const offA = subscribeToSource(options, () => {});
    await settle();

    const seen: string[] = [];
    const offB = subscribeToSource(options, (v) => seen.push(v));
    // No await, no timer advance — it should arrive synchronously.
    expect(seen).toEqual(["snapshot"]);

    offA();
    offB();
  });

  it("collapses a burst of triggers into one recompute", async () => {
    let computes = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => ++computes,
      intervalMs: 60_000,
      channels: ["nr:pos"],
      debounceMs: 200,
    };
    const off = subscribeToSource(options, () => {});
    await settle();
    expect(computes).toBe(1); // the initial run

    // Ten events in quick succession, as a busy station would produce.
    for (let i = 0; i < 10; i++) triggers[0]!();
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(computes).toBe(2);
    off();
  });

  it("still ticks when nothing is published", async () => {
    // Positions move with the clock, so a source must not depend on events.
    let computes = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => ++computes,
      intervalMs: 500,
      channels: ["nr:pos"],
    };
    const off = subscribeToSource(options, () => {});
    await settle();

    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    expect(computes).toBeGreaterThanOrEqual(4); // initial + 3 ticks
    off();
  });

  it("stops everything when the last subscriber leaves", async () => {
    let computes = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => ++computes,
      intervalMs: 500,
      channels: ["nr:pos"],
    };
    const offA = subscribeToSource(options, () => {});
    const offB = subscribeToSource(options, () => {});
    await settle();
    const after = computes;

    offA();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(computes).toBeGreaterThan(after); // one left, still running

    offB();
    const final = computes;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    expect(computes).toBe(final); // nobody watching, no work
    expect(unsubscribed).toContain("nr:pos");
    expect(sourceStats().sources).toBe(0);
  });

  it("does not run two computes at once, and folds a mid-flight trigger into one", async () => {
    let started = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => {
        started++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 100));
        concurrent--;
        return started;
      },
      intervalMs: 50,
      debounceMs: 10,
    };
    const off = subscribeToSource(options, () => {});

    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(maxConcurrent).toBe(1);
    off();
  });

  it("keeps the last good snapshot when a compute fails", async () => {
    let n = 0;
    const options = {
      key: uniqueKey(),
      compute: async () => {
        n++;
        if (n === 2) throw new Error("database blip");
        return n;
      },
      intervalMs: 500,
    };

    const seen: number[] = [];
    const off = subscribeToSource(options, (v) => seen.push(v));
    await settle();
    expect(seen).toEqual([1]);

    // The failing tick must not deliver anything, nor stop later ticks.
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(seen).toEqual([1]);

    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(seen).toEqual([1, 3]);
    off();
  });

  it("tolerates a subscriber that throws", async () => {
    const options = { key: uniqueKey(), compute: async () => 1, intervalMs: 1000 };
    const good: number[] = [];
    const offBad = subscribeToSource(options, () => {
      throw new Error("client went away mid-write");
    });
    const offGood = subscribeToSource(options, (v) => good.push(v));

    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    expect(good.length).toBeGreaterThan(0);
    offBad();
    offGood();
  });

  it("ignores a double release", async () => {
    const options = { key: uniqueKey(), compute: async () => 1, intervalMs: 1000 };
    const offA = subscribeToSource(options, () => {});
    const offB = subscribeToSource(options, () => {});
    await settle();

    // Both the abort handler and cancel() can fire for one stream.
    offA();
    offA();

    expect(sourceStats().subscribers).toBe(1);
    offB();
  });
});
