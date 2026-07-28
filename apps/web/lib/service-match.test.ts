import { describe, expect, it } from "vitest";
import {
  alignCallsToRun,
  callKeys,
  isAcceptable,
  orderRunStops,
  pickBestRun,
  plausibleTdMatch,
  runWindow,
  scoreRun,
  windowDistance,
  TD_TOLERANCE_MS,
  type CandidateRun,
  type RouteStop,
  type RunStop,
  type TdReport,
} from "./service-match";

function stop(seq: number, crs: string | null, dep: string | null, extra: Partial<RunStop> = {}): RunStop {
  return { seq, crs, schedArr: null, schedDep: dep, ...extra };
}

/** A Waterloo -> Woking pattern, as LDBWS would give it. */
const calls = [
  { crs: "WAT", scheduled: "07:00" },
  { crs: "CLJ", scheduled: "07:08" },
  { crs: "SUR", scheduled: "07:16" },
  { crs: "WOK", scheduled: "07:32" },
];

const run = (rid: string, ssd: string): CandidateRun => ({
  rid,
  ssd,
  stops: [
    stop(0, "WAT", "07:00"),
    stop(1, "CLJ", "07:08"),
    stop(2, "SUR", "07:16"),
    stop(3, "WOK", "07:32"),
  ],
});

describe("orderRunStops", () => {
  it("orders by seq", () => {
    const ordered = orderRunStops([stop(3, "WOK", "07:32"), stop(0, "WAT", "07:00"), stop(1, "CLJ", "07:08")]);
    expect(ordered.map((s) => s.crs)).toEqual(["WAT", "CLJ", "WOK"]);
  });

  it("breaks a seq tie on scheduled time", () => {
    // darwin-ingest reuses a neighbour's seq when a stop arrives without an SC.
    const ordered = orderRunStops([stop(1, "SUR", "07:16"), stop(1, "CLJ", "07:08")]);
    expect(ordered.map((s) => s.crs)).toEqual(["CLJ", "SUR"]);
  });

  it("does not mutate its input", () => {
    const input = [stop(3, "WOK", "07:32"), stop(0, "WAT", "07:00")];
    orderRunStops(input);
    expect(input.map((s) => s.crs)).toEqual(["WOK", "WAT"]);
  });
});

describe("scoreRun / isAcceptable", () => {
  const keys = callKeys(calls);

  it("scores a full match", () => {
    const score = scoreRun(run("r1", "2026-07-15").stops, keys);
    expect(score.matched).toBe(4);
    expect(score.coverage).toBe(1);
    expect(isAcceptable(score, keys.size)).toBe(true);
  });

  it("accepts a Darwin schedule that starts partway through the journey", () => {
    // Darwin only times this run from Clapham Junction onward.
    const partial = [stop(0, "CLJ", "07:08"), stop(1, "SUR", "07:16"), stop(2, "WOK", "07:32")];
    const score = scoreRun(partial, keys);
    expect(score.matched).toBe(3);
    expect(score.coverage).toBe(1); // measured against the smaller pattern
    expect(isAcceptable(score, keys.size)).toBe(true);
  });

  it("rejects a different train that merely shares two stop times", () => {
    // The old bar was a flat `matched >= 2`, which this would have passed.
    const other = [
      stop(0, "WAT", "07:00"),
      stop(1, "CLJ", "07:08"),
      stop(2, "BSK", "07:55"),
      stop(3, "WIN", "08:12"),
      stop(4, "SOU", "08:40"),
    ];
    const score = scoreRun(other, keys);
    expect(score.matched).toBe(2);
    expect(isAcceptable(score, keys.size)).toBe(false);
  });

  it("still resolves a short two-stop pattern, but demands all of it", () => {
    const shortCalls = [
      { crs: "SUR", scheduled: "07:16" },
      { crs: "WOK", scheduled: "07:32" },
    ];
    const shortKeys = callKeys(shortCalls);
    const full = scoreRun([stop(0, "SUR", "07:16"), stop(1, "WOK", "07:32")], shortKeys);
    expect(isAcceptable(full, shortKeys.size)).toBe(true);

    const half = scoreRun([stop(0, "SUR", "07:16"), stop(1, "BSK", "07:55")], shortKeys);
    expect(isAcceptable(half, shortKeys.size)).toBe(false);
  });

  it("matches on arrival or passing time, not just departure", () => {
    const keysWithArr = callKeys([{ crs: "WOK", scheduled: "07:32" }]);
    const arrOnly = [stop(0, "WOK", null, { schedArr: "07:32" })];
    expect(scoreRun(arrOnly, keysWithArr).matched).toBe(1);
  });
});

describe("runWindow / windowDistance", () => {
  it("spans the run's booked times on its service date", () => {
    const w = runWindow(run("r1", "2026-07-15").stops, "2026-07-15")!;
    expect(new Date(w.start).toISOString()).toBe("2026-07-15T06:00:00.000Z"); // 07:00 BST
    expect(new Date(w.end).toISOString()).toBe("2026-07-15T06:32:00.000Z");
  });

  it("spans midnight for an overnight run", () => {
    const overnight = [stop(0, "PAD", "23:45"), stop(1, "RDG", "00:20"), stop(2, "BRI", "01:40")];
    const w = runWindow(overnight, "2026-07-15")!;
    expect(w.end - w.start).toBe(115 * 60_000);
  });

  it("is zero distance while the run is due, and large when it isn't", () => {
    const w = runWindow(run("r1", "2026-07-15").stops, "2026-07-15");
    expect(windowDistance(w, Date.parse("2026-07-15T06:10:00Z"))).toBe(0);
    expect(windowDistance(w, Date.parse("2026-07-14T06:10:00Z"))).toBeGreaterThan(0);
    expect(windowDistance(null, Date.now())).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("pickBestRun", () => {
  const keys = callKeys(calls);
  const now = Date.parse("2026-07-15T06:10:00Z"); // 07:10 BST, mid-journey

  it("picks today's run over yesterday's identical one", () => {
    // The headline regression: identical (crs|HH:MM) patterns, so identical
    // scores. This used to be decided by Map iteration order, and picking
    // yesterday's completed run marked every stop 'departed'.
    const yesterday = run("rid-yesterday", "2026-07-14");
    const today = run("rid-today", "2026-07-15");

    expect(pickBestRun([yesterday, today], keys, now)?.run.rid).toBe("rid-today");
    // Order of candidates must not change the answer.
    expect(pickBestRun([today, yesterday], keys, now)?.run.rid).toBe("rid-today");
  });

  it("refuses when two candidates are genuinely indistinguishable", () => {
    const a = run("rid-a", "2026-07-15");
    const b = run("rid-b", "2026-07-15");
    expect(pickBestRun([a, b], keys, now)).toBeNull();
  });

  it("returns null when nothing clears the bar", () => {
    const unrelated: CandidateRun = {
      rid: "rid-other",
      ssd: "2026-07-15",
      stops: [stop(0, "MAN", "09:00"), stop(1, "LDS", "10:00")],
    };
    expect(pickBestRun([unrelated], keys, now)).toBeNull();
    expect(pickBestRun([], keys, now)).toBeNull();
  });

  it("prefers a better score even if the weaker match is closer in time", () => {
    const strong = run("rid-strong", "2026-07-15");
    const weak: CandidateRun = {
      rid: "rid-weak",
      ssd: "2026-07-15",
      stops: [stop(0, "WAT", "07:00"), stop(1, "CLJ", "07:08"), stop(2, "RDG", "07:50")],
    };
    expect(pickBestRun([weak, strong], keys, now)?.run.rid).toBe("rid-strong");
  });

  it("returns the winning run's stops in order", () => {
    const shuffled: CandidateRun = {
      rid: "rid-shuffled",
      ssd: "2026-07-15",
      stops: [stop(3, "WOK", "07:32"), stop(0, "WAT", "07:00"), stop(2, "SUR", "07:16"), stop(1, "CLJ", "07:08")],
    };
    expect(pickBestRun([shuffled], keys, now)!.stops.map((s) => s.crs)).toEqual([
      "WAT",
      "CLJ",
      "SUR",
      "WOK",
    ]);
  });
});

describe("alignCallsToRun", () => {
  it("lines up a straightforward route", () => {
    const idx = alignCallsToRun(["WAT", "CLJ", "SUR", "WOK"], run("r", "2026-07-15").stops);
    expect(idx).toEqual([0, 1, 2, 3]);
  });

  it("gives each visit its own row when a route calls twice at one station", () => {
    // The circular/reversing case. A CRS-keyed map kept only the LAST row, so
    // both calls read the second visit and every marker after it was wrong.
    const runStops = [
      { crs: "STP" },
      { crs: "ZFD" },
      { crs: "LBG" },
      { crs: "ZFD" }, // back through Farringdon on the return leg
      { crs: "STP" },
    ];
    const idx = alignCallsToRun(["STP", "ZFD", "LBG", "ZFD", "STP"], runStops);
    expect(idx).toEqual([0, 1, 2, 3, 4]);
    // Crucially the two ZFD calls resolve to DIFFERENT rows.
    expect(idx[1]).not.toBe(idx[3]);
  });

  it("skips run stops the calls don't advertise (passing points)", () => {
    const runStops = [{ crs: "WAT" }, { crs: "VXH" }, { crs: "CLJ" }, { crs: "WOK" }];
    expect(alignCallsToRun(["WAT", "CLJ", "WOK"], runStops)).toEqual([0, 2, 3]);
  });

  it("marks calls the run doesn't know about as unmatched", () => {
    const runStops = [{ crs: "CLJ" }, { crs: "WOK" }];
    expect(alignCallsToRun(["WAT", "CLJ", "WOK"], runStops)).toEqual([undefined, 0, 1]);
  });

  it("never matches backwards", () => {
    const runStops = [{ crs: "A" }, { crs: "B" }, { crs: "C" }];
    // 'A' appears again after C in the calls but the run has no second A.
    expect(alignCallsToRun(["A", "B", "C", "A"], runStops)).toEqual([0, 1, 2, undefined]);
  });

  it("handles calls with no CRS", () => {
    const runStops = [{ crs: "A" }, { crs: "B" }];
    expect(alignCallsToRun(["A", undefined, "B"], runStops)).toEqual([0, undefined, 1]);
  });
});

describe("plausibleTdMatch", () => {
  // A train booked through these intermediate stops this morning.
  const routeStops: RouteStop[] = [
    { index: 1, crs: "CLJ", scheduledMs: Date.parse("2026-07-15T06:08:00Z") },
    { index: 2, crs: "SUR", scheduledMs: Date.parse("2026-07-15T06:16:00Z") },
    { index: 3, crs: "WOK", scheduledMs: Date.parse("2026-07-15T06:32:00Z") },
  ];

  const report = (headcode: string, crs: string, at: string, event = "PASS"): TdReport => ({
    headcode,
    crs,
    reportedAtMs: Date.parse(at),
    event,
  });

  it("accepts a single train reporting near its booked time", () => {
    const m = plausibleTdMatch([report("2A45", "SUR", "2026-07-15T06:17:00Z")], routeStops);
    expect(m).toMatchObject({ headcode: "2A45", crs: "SUR", stopIndex: 2 });
  });

  it("takes the furthest-along stop when one train reports at several", () => {
    const m = plausibleTdMatch(
      [
        report("2A45", "CLJ", "2026-07-15T06:09:00Z"),
        report("2A45", "SUR", "2026-07-15T06:17:00Z"),
      ],
      routeStops,
    );
    expect(m?.stopIndex).toBe(2);
  });

  it("REJECTS a foreign train that merely happens to be at a station on this route", () => {
    // The reported bug: a different service standing at a shared intermediate
    // station was adopted as ours. Here it reports 6 hours off our booked time.
    const m = plausibleTdMatch([report("9Z99", "CLJ", "2026-07-15T12:08:00Z")], routeStops);
    expect(m).toBeNull();
  });

  it("rejects a report just outside the tolerance and accepts one just inside", () => {
    const booked = Date.parse("2026-07-15T06:16:00Z");
    const inside = new Date(booked + TD_TOLERANCE_MS - 60_000).toISOString();
    const outside = new Date(booked + TD_TOLERANCE_MS + 60_000).toISOString();
    expect(plausibleTdMatch([report("2A45", "SUR", inside)], routeStops)).not.toBeNull();
    expect(plausibleTdMatch([report("2A45", "SUR", outside)], routeStops)).toBeNull();
  });

  it("refuses when two plausible trains are both on the route", () => {
    const m = plausibleTdMatch(
      [
        report("2A45", "SUR", "2026-07-15T06:17:00Z"),
        report("2B67", "WOK", "2026-07-15T06:33:00Z"),
      ],
      routeStops,
    );
    expect(m).toBeNull();
  });

  it("cannot corroborate a stop with no booked time, so refuses", () => {
    const noTimes: RouteStop[] = [{ index: 1, crs: "CLJ" }];
    expect(plausibleTdMatch([report("2A45", "CLJ", "2026-07-15T06:09:00Z")], noTimes)).toBeNull();
  });

  it("ignores reports at stations that aren't on the route at all", () => {
    expect(plausibleTdMatch([report("2A45", "IPS", "2026-07-15T06:17:00Z")], routeStops)).toBeNull();
  });

  it("ignores rows with no headcode or no location", () => {
    const m = plausibleTdMatch(
      [
        { headcode: null, crs: "SUR", reportedAtMs: Date.parse("2026-07-15T06:17:00Z"), event: null },
        { headcode: "2A45", crs: null, reportedAtMs: Date.parse("2026-07-15T06:17:00Z"), event: null },
      ],
      routeStops,
    );
    expect(m).toBeNull();
  });

  it("returns null for no reports", () => {
    expect(plausibleTdMatch([], routeStops)).toBeNull();
  });
});
