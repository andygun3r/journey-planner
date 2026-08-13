import { describe, expect, it } from "vitest";
import {
  journeyBounds,
  journeyRouteFeatures,
  journeyStopFeatures,
} from "./journey-map-layer";
import type { JourneyLegView } from "../lib/journeys";

function leg(over: Partial<JourneyLegView> = {}): JourneyLegView {
  return {
    mode: "rail",
    originName: "London Kings Cross",
    originCrs: "KGX",
    destName: "York",
    destCrs: "YRK",
    departs: "2026-08-10T08:00:00Z",
    arrives: "2026-08-10T10:00:00Z",
    staySeated: false,
    cancelled: false,
    callCount: 0,
    originLat: 51.5308,
    originLon: -0.1238,
    destLat: 53.9578,
    destLon: -1.0934,
    geometry: [
      [-0.1238, 51.5308],
      [-1.0934, 53.9578],
    ],
    ...over,
  };
}

describe("journeyRouteFeatures", () => {
  it("draws one line per leg that has geometry", () => {
    const fc = journeyRouteFeatures([leg(), leg()], null);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.geometry.type).toBe("LineString");
  });

  it("omits a leg with no geometry rather than drawing a straight chord", () => {
    // Drawing KGX→YRK as a straight line would cut across country and read as
    // a real route. Better to draw nothing — see lib/corridor-geometry.ts.
    const fc = journeyRouteFeatures([leg({ geometry: undefined }), leg()], null);
    expect(fc.features).toHaveLength(1);
  });

  it("omits a degenerate single-point geometry", () => {
    const fc = journeyRouteFeatures([leg({ geometry: [[-0.1, 51.5]] })], null);
    expect(fc.features).toHaveLength(0);
  });

  it("marks the selected leg and dims the others", () => {
    const fc = journeyRouteFeatures([leg(), leg(), leg()], 1);
    expect(fc.features.map((f) => f.properties!.selected)).toEqual([false, true, false]);
    expect(fc.features.map((f) => f.properties!.dimmed)).toEqual([true, false, true]);
  });

  it("dims nothing when no leg is selected", () => {
    const fc = journeyRouteFeatures([leg(), leg()], null);
    expect(fc.features.every((f) => f.properties!.dimmed === false)).toBe(true);
  });

  it("flags walk legs so they can be dashed, not just recoloured", () => {
    const fc = journeyRouteFeatures([leg({ mode: "walk" }), leg()], null);
    expect(fc.features[0]!.properties!.walk).toBe(true);
    expect(fc.features[1]!.properties!.walk).toBe(false);
  });

  it("gives each mode its own colour", () => {
    const fc = journeyRouteFeatures([leg({ mode: "rail" }), leg({ mode: "tube" })], null);
    expect(fc.features[0]!.properties!.colour).not.toBe(fc.features[1]!.properties!.colour);
  });

  it("keeps the leg index, so a map click can select the right sheet row", () => {
    const fc = journeyRouteFeatures([leg({ geometry: undefined }), leg()], null);
    expect(fc.features[0]!.properties!.legIndex).toBe(1);
  });
});

describe("journeyStopFeatures", () => {
  it("marks only the journey's true start and end as termini", () => {
    const fc = journeyStopFeatures([
      leg({ destName: "Peterborough", destLat: 52.5747, destLon: -0.2497 }),
      leg({ originName: "Peterborough", originLat: 52.5747, originLon: -0.2497 }),
    ]);
    const termini = fc.features.filter((f) => f.properties!.terminus);
    expect(termini).toHaveLength(2);
    expect(termini.map((f) => f.properties!.name)).toEqual(["London Kings Cross", "York"]);
  });

  it("draws one marker at an interchange, not two stacked", () => {
    const fc = journeyStopFeatures([
      leg({ destName: "Peterborough", destLat: 52.5747, destLon: -0.2497 }),
      leg({ originName: "Peterborough", originLat: 52.5747, originLon: -0.2497 }),
    ]);
    expect(fc.features).toHaveLength(3); // KGX, Peterborough (once), York
  });

  it("skips stops with no coordinates instead of plotting them at null island", () => {
    const fc = journeyStopFeatures([leg({ originLat: undefined, originLon: undefined })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties!.name).toBe("York");
  });
});

describe("journeyBounds", () => {
  it("covers every leg's geometry", () => {
    const bounds = journeyBounds([leg()]);
    expect(bounds).not.toBeNull();
    const [west, south, east, north] = bounds!;
    expect(west).toBeCloseTo(-1.0934, 4);
    expect(south).toBeCloseTo(51.5308, 4);
    expect(east).toBeCloseTo(-0.1238, 4);
    expect(north).toBeCloseTo(53.9578, 4);
  });

  it("still frames a journey whose legs have only endpoints", () => {
    const bounds = journeyBounds([leg({ geometry: undefined })]);
    expect(bounds).not.toBeNull();
  });

  it("returns null when there is nothing to frame", () => {
    const bare = leg({
      geometry: undefined,
      originLat: undefined,
      originLon: undefined,
      destLat: undefined,
      destLon: undefined,
    });
    expect(journeyBounds([bare])).toBeNull();
    expect(journeyBounds([])).toBeNull();
  });
});
