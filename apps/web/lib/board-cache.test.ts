import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardOutcome } from "./board";

const getBoard = vi.fn<(...args: unknown[]) => Promise<BoardOutcome>>();
vi.mock("./board", () => ({ getBoard: (...args: unknown[]) => getBoard(...args) }));

const { boardCacheStats, cachedBoard } = await import("./board-cache");

function ok(crs: string): BoardOutcome {
  return {
    ok: true,
    board: {
      crs,
      stationName: crs,
      generatedAt: "2026-07-30T12:00:00.000Z",
      live: true,
      source: "ldbws",
      messages: [],
      disruptions: [],
      departures: [],
      arrivals: [],
    },
  };
}

/** A build that only finishes when told to — the way to observe overlap. */
function deferred() {
  let resolve!: (value: BoardOutcome) => void;
  const promise = new Promise<BoardOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  getBoard.mockReset();
  (globalThis as { __mainlineBoardCache?: Map<string, unknown> }).__mainlineBoardCache = new Map();
});

describe("cachedBoard", () => {
  it("builds the board on the first request", async () => {
    getBoard.mockResolvedValue(ok("KGX"));
    await expect(cachedBoard("KGX")).resolves.toEqual(ok("KGX"));
    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  it("serves later requests for the same station without rebuilding", async () => {
    getBoard.mockResolvedValue(ok("KGX"));
    await cachedBoard("KGX");
    await cachedBoard("KGX");
    await cachedBoard("KGX");
    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  // The one that matters. A page refresh sends every request in the same
  // instant, so there is no finished board to hit yet — a cache that only held
  // results would let all of them through to LDBWS.
  it("shares one build between requests that arrive together", async () => {
    const d = deferred();
    getBoard.mockReturnValue(d.promise);

    const inFlight = Array.from({ length: 30 }, () => cachedBoard("KGX"));
    expect(getBoard).toHaveBeenCalledTimes(1);

    d.resolve(ok("KGX"));
    const results = await Promise.all(inFlight);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  it("keeps different stations apart", async () => {
    getBoard.mockImplementation((crs) => Promise.resolve(ok(crs as string)));
    await cachedBoard("KGX");
    await cachedBoard("EUS");
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("keeps a calling-at filter apart from the unfiltered board", async () => {
    getBoard.mockResolvedValue(ok("KGX"));
    await cachedBoard("KGX");
    await cachedBoard("KGX", undefined, 20, "YRK");
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("treats a lower-case station as the same station", async () => {
    getBoard.mockResolvedValue(ok("KGX"));
    await cachedBoard("kgx");
    await cachedBoard("KGX");
    expect(getBoard).toHaveBeenCalledTimes(1);
  });

  // A brief LDBWS outage must not be pinned for the whole TTL.
  it("retries after a failed build instead of caching the failure", async () => {
    getBoard.mockResolvedValueOnce({ ok: false, reason: "engine-offline" });
    getBoard.mockResolvedValueOnce(ok("KGX"));
    await expect(cachedBoard("KGX")).resolves.toEqual({ ok: false, reason: "engine-offline" });
    await expect(cachedBoard("KGX")).resolves.toEqual(ok("KGX"));
    expect(getBoard).toHaveBeenCalledTimes(2);
  });

  it("retries after a thrown build too", async () => {
    getBoard.mockRejectedValueOnce(new Error("boom"));
    getBoard.mockResolvedValueOnce(ok("KGX"));
    await expect(cachedBoard("KGX")).rejects.toThrow("boom");
    await expect(cachedBoard("KGX")).resolves.toEqual(ok("KGX"));
  });

  it("rebuilds once the entry has aged out", async () => {
    vi.useFakeTimers();
    try {
      getBoard.mockResolvedValue(ok("KGX"));
      await cachedBoard("KGX");
      vi.setSystemTime(Date.now() + 16_000);
      await cachedBoard("KGX");
      expect(getBoard).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts hits and misses so the sharing is visible", async () => {
    const before = boardCacheStats();
    getBoard.mockResolvedValue(ok("KGX"));
    await cachedBoard("KGX");
    await cachedBoard("KGX");
    const after = boardCacheStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });
});
