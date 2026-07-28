import { describe, expect, it } from "vitest";
import {
  hhmmToIso,
  londonDateKey,
  londonOffsetMinutes,
  londonOffsetString,
  minutesLate,
  parseHhmm,
  resolvePatternTimes,
  ukHhmm,
  ukParts,
} from "./uk-time";

/**
 * Note: none of these fix the host timezone. Every helper pins Europe/London
 * explicitly, so the suite passing under an arbitrary TZ is part of the point.
 */

describe("parseHhmm", () => {
  it("accepts LDBWS HH:MM and Darwin HH:MM:SS", () => {
    expect(parseHhmm("07:42")).toBe(7 * 60 + 42);
    expect(parseHhmm("07:42:30")).toBe(7 * 60 + 42);
    expect(parseHhmm("00:00")).toBe(0);
    expect(parseHhmm("23:59")).toBe(23 * 60 + 59);
  });

  it("rejects status strings and nonsense", () => {
    for (const v of ["On time", "Delayed", "Cancelled", "No report", "", null, undefined, "25:00", "12:60"]) {
      expect(parseHhmm(v)).toBeNull();
    }
  });
});

describe("londonOffsetMinutes", () => {
  it("is +0 in winter and +60 during BST", () => {
    expect(londonOffsetMinutes(new Date("2026-01-15T12:00:00Z"))).toBe(0);
    expect(londonOffsetMinutes(new Date("2026-07-15T12:00:00Z"))).toBe(60);
  });

  it("flips exactly at the 2026 transitions", () => {
    // BST starts 2026-03-29 01:00 UTC, ends 2026-10-25 02:00 UTC.
    expect(londonOffsetMinutes(new Date("2026-03-29T00:59:00Z"))).toBe(0);
    expect(londonOffsetMinutes(new Date("2026-03-29T01:00:00Z"))).toBe(60);
    expect(londonOffsetMinutes(new Date("2026-10-25T00:59:00Z"))).toBe(60);
    expect(londonOffsetMinutes(new Date("2026-10-25T01:00:00Z"))).toBe(0);
  });

  it("formats as an ISO suffix", () => {
    expect(londonOffsetString(new Date("2026-01-15T12:00:00Z"))).toBe("+00:00");
    expect(londonOffsetString(new Date("2026-07-15T12:00:00Z"))).toBe("+01:00");
  });
});

describe("ukParts / londonDateKey", () => {
  it("reads London wall-clock, not UTC", () => {
    // 23:30 UTC in July is 00:30 the NEXT day in London.
    const p = ukParts(new Date("2026-07-14T23:30:00Z"));
    expect(p).toMatchObject({ year: 2026, month: 7, day: 15, hour: 0, minute: 30 });
    expect(londonDateKey(new Date("2026-07-14T23:30:00Z"))).toBe("2026-07-15");
  });

  it("renders midnight as hour 0, never 24", () => {
    expect(ukParts(new Date("2026-01-15T00:00:00Z")).hour).toBe(0);
  });
});

describe("hhmmToIso", () => {
  it("resolves a time later today", () => {
    const anchor = new Date("2026-07-15T06:00:00Z"); // 07:00 London
    expect(hhmmToIso("07:42", anchor)).toBe("2026-07-15T06:42:00.000Z");
  });

  it("applies the BST offset", () => {
    // 07:42 London in July is 06:42Z; in January it is 07:42Z.
    expect(hhmmToIso("07:42", new Date("2026-01-15T07:00:00Z"))).toBe("2026-01-15T07:42:00.000Z");
  });

  it("rolls forward past midnight", () => {
    // Board generated 23:50 London, listing the 00:14 departure.
    const anchor = new Date("2026-07-15T22:50:00Z"); // 23:50 London
    expect(hhmmToIso("00:14", anchor)).toBe("2026-07-15T23:14:00.000Z"); // 00:14 on the 16th
  });

  it("rolls BACKWARD for a time just before midnight seen after it", () => {
    // The regression: a board generated at 00:03 still listing 23:59. The old
    // forward-only rule dated it ~24h in the future.
    const anchor = new Date("2026-07-15T23:03:00Z"); // 00:03 London on the 16th
    const iso = hhmmToIso("23:59", anchor)!;
    expect(Date.parse(iso)).toBeLessThan(anchor.getTime());
    expect(iso).toBe("2026-07-15T22:59:00.000Z"); // 23:59 on the 15th
  });

  it("returns undefined for status strings", () => {
    expect(hhmmToIso("On time", new Date())).toBeUndefined();
    expect(hhmmToIso(undefined, new Date())).toBeUndefined();
  });

  it("round-trips through ukHhmm", () => {
    const anchor = new Date("2026-07-15T06:00:00Z");
    expect(ukHhmm(hhmmToIso("07:42", anchor))).toBe("07:42");
    expect(ukHhmm(hhmmToIso("23:05", anchor))).toBe("23:05");
  });
});

describe("resolvePatternTimes", () => {
  const anchor = new Date("2026-07-15T20:00:00Z"); // 21:00 London

  it("keeps a same-day pattern monotonic", () => {
    const out = resolvePatternTimes(["21:10", "21:24", "21:47", "22:03"], anchor);
    const ms = out.map((t) => Date.parse(t!));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(out.map((t) => ukHhmm(t))).toEqual(["21:10", "21:24", "21:47", "22:03"]);
  });

  it("rolls the day forward across midnight, staying monotonic", () => {
    const out = resolvePatternTimes(["23:47", "00:14", "00:52", "01:32"], anchor);
    const ms = out.map((t) => Date.parse(t!));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    // The stops after midnight are on the following London date.
    expect(londonDateKey(new Date(out[0]!))).toBe("2026-07-15");
    expect(londonDateKey(new Date(out[1]!))).toBe("2026-07-16");
    expect(londonDateKey(new Date(out[3]!))).toBe("2026-07-16");
    expect(out.map((t) => ukHhmm(t))).toEqual(["23:47", "00:14", "00:52", "01:32"]);
  });

  it("does NOT scatter an overnight pattern the way per-stop anchoring did", () => {
    // Anchored individually against "now", 00:14 and 01:32 would resolve to a
    // different day from 23:47 and the pattern would come out non-monotonic.
    const out = resolvePatternTimes(["23:47", "00:14"], anchor).map((t) => Date.parse(t!));
    expect(out[1]! - out[0]!).toBe(27 * 60_000);
  });

  it("survives a whole extra day of running", () => {
    const out = resolvePatternTimes(["22:00", "23:30", "00:30", "23:00", "00:30"], anchor);
    const ms = out.map((t) => Date.parse(t!));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it("skips unparseable entries without disturbing the walk", () => {
    const out = resolvePatternTimes(["21:10", "On time", "21:47"], anchor);
    expect(out[1]).toBeUndefined();
    expect(ukHhmm(out[0])).toBe("21:10");
    expect(ukHhmm(out[2])).toBe("21:47");
    expect(Date.parse(out[2]!)).toBeGreaterThan(Date.parse(out[0]!));
  });

  it("walks backwards when the head of the pattern has no times", () => {
    const out = resolvePatternTimes([undefined, "23:47", "00:14"], anchor);
    expect(out[0]).toBeUndefined();
    expect(Date.parse(out[2]!)).toBeGreaterThan(Date.parse(out[1]!));
  });

  it("handles an empty or fully unparseable pattern", () => {
    expect(resolvePatternTimes([], anchor)).toEqual([]);
    expect(resolvePatternTimes(["On time", "Delayed"], anchor)).toEqual([undefined, undefined]);
  });

  it("crosses the spring DST transition without losing an hour", () => {
    // BST starts 2026-03-29: 01:00 London jumps to 02:00.
    const dstAnchor = new Date("2026-03-28T23:00:00Z");
    const out = resolvePatternTimes(["23:40", "00:20", "03:10"], dstAnchor);
    const ms = out.map((t) => Date.parse(t!));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(ukHhmm(out[2])).toBe("03:10");
  });
});

describe("minutesLate", () => {
  it("computes lateness from instants", () => {
    expect(minutesLate("2026-07-15T06:42:00Z", "2026-07-15T06:46:00Z")).toBe(4);
  });

  it("returns a negative for early running", () => {
    expect(minutesLate("2026-07-15T06:42:00Z", "2026-07-15T06:40:00Z")).toBe(-2);
  });

  it("does not wrap a long delay into a negative", () => {
    // The old wall-clock version added 1440 to anything under -720.
    expect(minutesLate("2026-07-15T06:00:00Z", "2026-07-15T20:00:00Z")).toBe(840);
  });

  it("handles a delay across midnight", () => {
    expect(minutesLate("2026-07-15T22:55:00Z", "2026-07-15T23:10:00Z")).toBe(15);
  });

  it("returns undefined on missing or bad input", () => {
    expect(minutesLate(undefined, "2026-07-15T06:42:00Z")).toBeUndefined();
    expect(minutesLate("2026-07-15T06:42:00Z", "On time")).toBeUndefined();
  });
});

describe("ukHhmm", () => {
  it("formats in London time regardless of host TZ", () => {
    expect(ukHhmm("2026-07-15T06:42:00Z")).toBe("07:42"); // BST
    expect(ukHhmm("2026-01-15T06:42:00Z")).toBe("06:42"); // GMT
  });

  it("returns undefined rather than 'Invalid Date' for a bare HH:MM", () => {
    // This is exactly what darwin-board.ts used to feed the board.
    expect(ukHhmm("18:42")).toBeUndefined();
    expect(ukHhmm(undefined)).toBeUndefined();
  });
});
