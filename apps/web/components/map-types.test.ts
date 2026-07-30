import { describe, expect, it } from "vitest";
import { applyMapDelta, toMapTrain, type LiveTrain, type MapTrain } from "./map-types";

function train(id: string, extra: Partial<MapTrain> = {}): MapTrain {
  return { id, lat: 51, lon: -0.1, reportedAgoSeconds: 10, ...extra };
}

describe("applyMapDelta", () => {
  it("adds trains it has not seen", () => {
    const next = applyMapDelta(new Map(), { upserted: [train("A")], removed: [] });
    expect([...next.keys()]).toEqual(["A"]);
  });

  it("replaces a train it already holds", () => {
    const before = new Map([["A", train("A", { lat: 51 })]]);
    const next = applyMapDelta(before, { upserted: [train("A", { lat: 52 })], removed: [] });
    expect(next.get("A")?.lat).toBe(52);
    expect(next.size).toBe(1);
  });

  it("drops removed trains and leaves the rest alone", () => {
    const before = new Map([
      ["A", train("A")],
      ["B", train("B")],
    ]);
    const next = applyMapDelta(before, { upserted: [], removed: ["A"] });
    expect([...next.keys()]).toEqual(["B"]);
  });

  it("ignores a removal for a train it never had", () => {
    const before = new Map([["A", train("A")]]);
    const next = applyMapDelta(before, { upserted: [], removed: ["ZZ"] });
    expect([...next.keys()]).toEqual(["A"]);
  });

  // React re-renders on reference identity, so mutating in place would look
  // correct in the data and draw nothing on the map.
  it("returns a new map and leaves the previous one untouched", () => {
    const before = new Map([["A", train("A")]]);
    const next = applyMapDelta(before, { upserted: [train("B")], removed: ["A"] });
    expect(next).not.toBe(before);
    expect([...before.keys()]).toEqual(["A"]);
  });
});

describe("toMapTrain", () => {
  const full: LiveTrain = {
    id: "T1",
    lat: 51.5,
    lon: -0.12,
    headcode: "1A01",
    reportedAgoSeconds: 30,
    rid: "R1",
    path: [
      { crs: "AAA", name: "A", lat: 51.4, lon: -0.2, status: "departed" },
      { crs: "BBB", name: "B", lat: 51.6, lon: -0.05, status: "current" },
      { crs: "CCC", name: "C", lat: 51.7, lon: 0.02, status: "upcoming" },
    ],
    pathGeometry: [null, null],
  };

  it("keeps only the next stop's coordinates, not the whole path", () => {
    const mapped = toMapTrain(full);
    expect(mapped.nextLat).toBe(51.7);
    expect(mapped.nextLon).toBe(0.02);
    expect(mapped).not.toHaveProperty("path");
    expect(mapped).not.toHaveProperty("pathGeometry");
  });

  it("leaves the next stop unset when there is no path", () => {
    const mapped = toMapTrain({ id: "T2", lat: 51, lon: -0.1, reportedAgoSeconds: 5 });
    expect(mapped.nextLat).toBeUndefined();
    expect(mapped.nextLon).toBeUndefined();
  });
});
