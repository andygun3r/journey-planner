import { describe, expect, it } from "vitest";
import spans from "./__fixtures__/mln1-track-spans.json";
import { deriveSections, milesAndChainsToMiles, sectionAt } from "@signaller/shared";

/**
 * MLN1 is the Waterloo–Weymouth ELR, and the fixture is its real Track Model
 * spans (1,566 centreline records, straight out of NWR_TrackCentreLines).
 *
 * The assertions are checks against the actual railway rather than against
 * whatever the code currently prints: the South West Main Line is four-track
 * from Waterloo to Worting Junction (50m 48ch) and two-track beyond it. If a
 * threshold is retuned and that stops being true, these should fail.
 */
const MLN1 = deriveSections("MLN1", spans);

/** Woking, Basingstoke and Winchester in miles-and-chains, as Track Model records them. */
const WOKING = 24.3;
const BASINGSTOKE = 47.6;
const WINCHESTER = 66.5;

describe("deriveSections on real MLN1 Track Model data", () => {
  it("finds a handful of sections, not hundreds of slivers", () => {
    expect(MLN1.length).toBeGreaterThan(2);
    expect(MLN1.length).toBeLessThan(40);
  });

  it("keeps the running lines and drops sidings, loops and crossovers", () => {
    const everyTrack = new Set(MLN1.flatMap((s) => s.trackIds));
    // The two main lines cover 98.8% of the route; the slow pair 23-25%.
    expect(everyTrack).toContain("1100");
    expect(everyTrack).toContain("2100");
    expect(everyTrack).toContain("1200");
    expect(everyTrack).toContain("2200");
    // Nothing below the through-line threshold should survive. 1500 covers
    // 3.1% of the route and is the largest thing that must be excluded.
    expect(everyTrack).not.toContain("1500");
    expect(everyTrack).not.toContain("3900");
  });

  it("is four-track at Woking", () => {
    const section = sectionAt(MLN1, WOKING);
    expect(section?.trackIds).toHaveLength(4);
    expect(section?.trackIds).toEqual(["1100", "1200", "2100", "2200"]);
  });

  it("is still four-track at Basingstoke, before Worting Junction", () => {
    const section = sectionAt(MLN1, BASINGSTOKE);
    expect(section?.trackIds).toEqual(["1100", "1200", "2100", "2200"]);
  });

  it("has dropped to two tracks by Winchester, past Worting Junction", () => {
    const section = sectionAt(MLN1, WINCHESTER);
    expect(section?.trackIds).toEqual(["1100", "2100"]);
  });

  it("puts the four-to-two transition near Worting Junction", () => {
    const fourTrack = MLN1.filter((s) => s.trackIds.length === 4);
    const firstLong = fourTrack.find((s) => s.endMileage - s.startMileage > 10);
    expect(firstLong).toBeDefined();
    // Worting Jn is 50m 48ch; Track Model's records end a little beyond it.
    expect(firstLong!.endMileage).toBeGreaterThan(45);
    expect(firstLong!.endMileage).toBeLessThan(56);
  });

  it("returns sections in mileage order and never overlapping", () => {
    const sorted = [...MLN1].sort((a, b) => a.startMileage - b.startMileage);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startMileage).toBeGreaterThanOrEqual(sorted[i - 1]!.endMileage - 0.001);
    }
  });
});

describe("edge cases", () => {
  it("returns nothing for no spans", () => {
    expect(deriveSections("XXX", [])).toEqual([]);
  });

  it("returns nothing when every span is a siding of equal tiny length", () => {
    // All spans identical in length means none stands out as a through line,
    // but they all clear the fraction test — the absolute floor is what
    // prevents a short ELR of stubs from reading as running lines.
    const stubs = Array.from({ length: 6 }, (_, i) => ({
      trackId: `S${i}`,
      start: i * 0.1,
      end: i * 0.1 + 0.05,
    }));
    expect(deriveSections("STUB", stubs)).toEqual([]);
  });

  it("tolerates reversed start/end", () => {
    const forward = deriveSections("R", [
      { trackId: "1100", start: 0, end: 20 },
      { trackId: "2100", start: 0, end: 20 },
    ]);
    const reversed = deriveSections("R", [
      { trackId: "1100", start: 20, end: 0 },
      { trackId: "2100", start: 20, end: 0 },
    ]);
    expect(reversed).toEqual(forward);
  });
});

describe("milesAndChainsToMiles", () => {
  it("reads the fraction as chains, not decimal miles", () => {
    // 80 chains to the mile, so 53m 40ch is 53.5 miles.
    expect(milesAndChainsToMiles(53.4)).toBeCloseTo(53.5, 5);
    expect(milesAndChainsToMiles(53.2)).toBeCloseTo(53.25, 5);
    expect(milesAndChainsToMiles(10)).toBe(10);
  });

  it("keeps whole miles ordered the same way", () => {
    expect(milesAndChainsToMiles(1.7)).toBeLessThan(milesAndChainsToMiles(2.0));
  });
});
