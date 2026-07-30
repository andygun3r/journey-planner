import { describe, expect, it } from "vitest";
import {
  inTravelOrder,
  interpolateTimeFromPattern,
  scoreAtLocation,
  SCORE_ACTUAL_IN_WINDOW,
  SCORE_BOOKED_MATCH,
  SCORE_INTERPOLATED,
  SCORE_INTERPOLATED_BOOKED,
  SCORE_NONE,
  type PatternRow,
} from "./correlation.js";

/**
 * These lock in the correlation rules that used to live in store.ts, so the
 * move to a cached, batch-loaded lookup cannot quietly change any answer.
 * Several cases are the ones the original comments cite from live traffic.
 */

const stop = (
  seq: number,
  tiploc: string,
  times: Partial<Pick<PatternRow, "schedArr" | "schedDep" | "schedPass" | "crs">> = {},
): PatternRow => ({
  seq,
  tiploc,
  crs: times.crs ?? null,
  schedArr: times.schedArr ?? null,
  schedDep: times.schedDep ?? null,
  schedPass: times.schedPass ?? null,
});

/**
 * Booked HH:MM times are LONDON wall-clock, not UTC. The test day is in July,
 * so London is BST and one hour ahead — "12:00" in a schedule is 11:00Z. This
 * helper keeps the expectations written in the same clock the data uses.
 *
 * Worth being explicit about: getting this wrong is the single easiest mistake
 * to make against these feeds, and CLAUDE.md calls it out for the Network Rail
 * timestamps too.
 */
const london = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00+01:00`);

// A fixed mid-day report time, so nothing here depends on midnight rollover.
const AT = london("12:00");

describe("inTravelOrder", () => {
  it("orders by booked time, not seq", () => {
    // The live case from the comment: seq says one thing, the clock another.
    const pattern = [
      stop(3, "EXD", { schedDep: "12:30" }),
      stop(26, "TGM", { schedDep: "11:00" }),
      stop(27, "DWL", { schedDep: "11:20" }),
    ];
    expect(inTravelOrder(pattern).map((p) => p.tiploc)).toEqual(["TGM", "DWL", "EXD"]);
  });

  it("breaks exact time ties with seq", () => {
    const pattern = [stop(9, "BBB", { schedDep: "12:00" }), stop(4, "AAA", { schedDep: "12:00" })];
    expect(inTravelOrder(pattern).map((p) => p.tiploc)).toEqual(["AAA", "BBB"]);
  });

  it("keeps untimed stops in seq order relative to the rest", () => {
    const pattern = [stop(5, "MID"), stop(1, "FIRST", { schedDep: "11:00" })];
    expect(inTravelOrder(pattern).map((p) => p.tiploc)).toEqual(["FIRST", "MID"]);
  });

  it("does not mutate its input", () => {
    const pattern = [stop(2, "B", { schedDep: "11:00" }), stop(1, "A", { schedDep: "10:00" })];
    const before = pattern.map((p) => p.tiploc);
    inTravelOrder(pattern);
    expect(pattern.map((p) => p.tiploc)).toEqual(before);
  });
});

describe("scoreAtLocation", () => {
  const pattern = [
    stop(1, "AAA", { schedDep: "11:00", crs: "AAA" }),
    stop(2, "BBB", { schedArr: "12:00", crs: "BBB" }),
    stop(3, "CCC", { schedArr: "13:00", crs: "CCC" }),
  ];

  it("scores a booked time matching TRUST's own booked time highest", () => {
    const bookedAt = london("12:00");
    expect(scoreAtLocation(pattern, false, "BBB", null, AT, bookedAt)).toBe(SCORE_BOOKED_MATCH);
  });

  it("scores a booked time inside the loose window when there is no booked time to compare", () => {
    expect(scoreAtLocation(pattern, false, "BBB", null, AT)).toBe(SCORE_ACTUAL_IN_WINDOW);
  });

  it("returns nothing for a location the candidate never calls at", () => {
    expect(scoreAtLocation(pattern, false, "ZZZ", null, AT)).toBe(SCORE_NONE);
  });

  it("returns nothing when the candidate is deactivated, however well it fits", () => {
    const bookedAt = london("12:00");
    expect(scoreAtLocation(pattern, true, "BBB", null, AT, bookedAt)).toBe(SCORE_NONE);
  });

  it("returns nothing with no location to check against", () => {
    expect(scoreAtLocation(pattern, false, null, null, AT)).toBe(SCORE_NONE);
  });

  it("matches on crs when tiploc is unknown", () => {
    // Darwin uses per-platform tiploc variants for one station, so crs has to
    // work on its own — see the note in the original comment about Victoria.
    expect(scoreAtLocation(pattern, false, null, "BBB", AT)).toBe(SCORE_ACTUAL_IN_WINDOW);
  });

  it("rejects a booked time far outside the window", () => {
    const farOff = [stop(1, "BBB", { schedArr: "04:00", crs: "BBB" })];
    expect(scoreAtLocation(farOff, false, "BBB", null, AT)).toBe(SCORE_NONE);
  });

  it("interpolates for a stop with no booked time of its own", () => {
    // The 47%-of-rows case: a timing point Darwin never carries a time for.
    const withBlank = [
      stop(1, "AAA", { schedDep: "11:00" }),
      stop(2, "BLANK"),
      stop(3, "CCC", { schedArr: "13:00" }),
    ];
    expect(scoreAtLocation(withBlank, false, "BLANK", null, AT)).toBe(SCORE_INTERPOLATED);
  });

  it("rates an interpolated time agreeing with TRUST's booked time above a loose hit", () => {
    const withBlank = [
      stop(1, "AAA", { schedDep: "11:00" }),
      stop(2, "BLANK"),
      stop(3, "CCC", { schedArr: "13:00" }),
    ];
    const bookedAt = london("12:00");
    expect(scoreAtLocation(withBlank, false, "BLANK", null, AT, bookedAt)).toBe(
      SCORE_INTERPOLATED_BOOKED,
    );
  });

  it("prefers a real booked row over interpolating", () => {
    // A blank row must not drag down a candidate that also has a timed row here.
    const mixed = [
      stop(1, "AAA", { schedDep: "11:00", crs: "SHARED" }),
      stop(2, "BLANK", { crs: "SHARED" }),
      stop(3, "CCC", { schedArr: "12:00", crs: "SHARED" }),
    ];
    expect(scoreAtLocation(mixed, false, null, "SHARED", AT)).toBe(SCORE_ACTUAL_IN_WINDOW);
  });

  it("scores nothing on an empty pattern", () => {
    expect(scoreAtLocation([], false, "AAA", null, AT)).toBe(SCORE_NONE);
  });
});

describe("interpolateTimeFromPattern", () => {
  it("interpolates between the nearest timed neighbours", () => {
    const pattern = [
      stop(1, "AAA", { schedDep: "11:00" }),
      stop(2, "BLANK"),
      stop(3, "CCC", { schedArr: "13:00" }),
    ];
    const iso = interpolateTimeFromPattern(pattern, "BLANK", null, AT);
    expect(iso).not.toBeNull();
    // Halfway between 11:00 and 13:00 London.
    expect(iso).toBe(london("12:00").toISOString());
  });

  it("returns null for a stop that already has its own time", () => {
    const pattern = [stop(1, "AAA", { schedDep: "11:00" }), stop(2, "BBB", { schedArr: "12:00" })];
    expect(interpolateTimeFromPattern(pattern, "BBB", null, AT)).toBeNull();
  });

  it("returns null for a stop not in the pattern", () => {
    const pattern = [stop(1, "AAA", { schedDep: "11:00" })];
    expect(interpolateTimeFromPattern(pattern, "NOPE", null, AT)).toBeNull();
  });

  it("returns null when fewer than two stops carry a time", () => {
    const pattern = [stop(1, "AAA", { schedDep: "11:00" }), stop(2, "BLANK")];
    expect(interpolateTimeFromPattern(pattern, "BLANK", null, AT)).toBeNull();
  });

  it("extrapolates into a trailing untimed tail", () => {
    // The CREWSJN case: the target sits after every timed stop, so there is no
    // enclosing pair and interpolation alone used to give up.
    const pattern = [
      stop(1, "AAA", { schedDep: "11:00" }),
      stop(2, "BBB", { schedDep: "11:30" }),
      stop(3, "TAIL"),
    ];
    const iso = interpolateTimeFromPattern(pattern, "TAIL", null, AT);
    expect(iso).not.toBeNull();
    expect(iso).toBe(london("12:00").toISOString());
  });

  it("extrapolates into a leading untimed tail", () => {
    const pattern = [
      stop(1, "HEAD"),
      stop(2, "BBB", { schedDep: "11:30" }),
      stop(3, "CCC", { schedDep: "12:00" }),
    ];
    const iso = interpolateTimeFromPattern(pattern, "HEAD", null, AT);
    expect(iso).not.toBeNull();
    expect(iso).toBe(london("11:00").toISOString());
  });

  it("refuses a degenerate rate rather than inventing a time hours out", () => {
    // Two timed stops sharing a time give a zero rate; extrapolating over a
    // long tail from that is meaningless.
    const pattern = [
      stop(1, "AAA", { schedDep: "11:00" }),
      stop(2, "BBB", { schedDep: "11:00" }),
      stop(3, "TAIL"),
    ];
    expect(interpolateTimeFromPattern(pattern, "TAIL", null, AT)).toBeNull();
  });
});
