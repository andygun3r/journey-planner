import { deriveSections } from "@signaller/shared";
import { describe, expect, it } from "vitest";
import spans from "./__fixtures__/mln1-track-spans.json";
import {
  BLUEPRINT_TOP,
  placeStations,
  placeTracks,
  waterlooPlatformGroup,
} from "./blueprint-layout";
import { SIGNALLING_CORRIDORS, trackRoleName } from "./signalling-corridors";

const swml = SIGNALLING_CORRIDORS.swml!;
const MLN1 = deriveSections("MLN1", spans);

/** A few real Track Model positions, in miles-and-chains as the table stores them. */
const positions = [
  { crs: "WAT", elr: "MLN1", mileage: 0.0 },
  { crs: "VXH", elr: "MLN1", mileage: 1.28 },
  { crs: "CLJ", elr: "MLN1", mileage: 3.61 },
  { crs: "WOK", elr: "MLN1", mileage: 24.3 },
  { crs: "BSK", elr: "MLN1", mileage: 47.6 },
  { crs: "WIN", elr: "MLN1", mileage: 66.5 },
];

describe("placeStations", () => {
  it("runs top to bottom in corridor order", () => {
    const placed = placeStations(swml.stations, positions);
    expect(placed[0]!.station.crs).toBe("WAT");
    expect(placed.at(-1)!.station.crs).toBe("WEY");
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!.y).toBeGreaterThan(placed[i - 1]!.y);
    }
  });

  it("starts at the top margin", () => {
    const placed = placeStations(swml.stations, positions);
    expect(placed[0]!.y).toBe(BLUEPRINT_TOP);
  });

  it("spaces by real distance, not evenly", () => {
    const placed = placeStations(swml.stations, positions);
    const y = (crs: string) => placed.find((p) => p.station.crs === crs)!.y;
    // Waterloo->Vauxhall is 1.35mi; Clapham->Woking is nearly 21mi. The old
    // renderer gave both exactly one 74px step.
    const shortHop = y("VXH") - y("WAT");
    const longHop = y("WOK") - y("CLJ");
    expect(longHop).toBeGreaterThan(shortHop * 2);
  });

  it("marks stations Track Model could not place", () => {
    const placed = placeStations(swml.stations, positions);
    expect(placed.find((p) => p.station.crs === "WAT")!.estimated).toBe(false);
    expect(placed.find((p) => p.station.crs === "WOK")!.estimated).toBe(false);
    // Nothing in the fixture positions Sway, so it must not claim precision.
    expect(placed.find((p) => p.station.crs === "SWY")!.estimated).toBe(true);
    expect(placed.find((p) => p.station.crs === "SWY")!.mile).toBeUndefined();
  });

  it("falls back to even spacing when nothing is placed, and says so", () => {
    const placed = placeStations(swml.stations, []);
    expect(placed.every((p) => p.estimated)).toBe(true);
    const gaps = placed.slice(1).map((p, i) => p.y - placed[i]!.y);
    expect(new Set(gaps).size).toBe(1);
  });

  it("does not treat an ELR change as real distance", () => {
    // The live bug: the SWML runs over RDG1, BML1, BML2 and BML3, each with its
    // own mileage from zero. Read as one number line, Moreton (BML2 mile 129)
    // to Upwey (BML3 mile 166) looked like a 37-mile gap, which pinned that hop
    // to the maximum and squashed everything else against the minimum.
    const crossElr = [
      { crs: "MTN", elr: "BML2", mileage: 129.62 },
      { crs: "DCH", elr: "BML2", mileage: 135.48 },
      { crs: "UPW", elr: "BML3", mileage: 166.14 },
      { crs: "WEY", elr: "BML3", mileage: 168.12 },
    ];
    const placed = placeStations(
      [
        { crs: "MTN", name: "Moreton (Dorset)" },
        { crs: "DCH", name: "Dorchester South" },
        { crs: "UPW", name: "Upwey" },
        { crs: "WEY", name: "Weymouth" },
      ],
      crossElr,
    );
    const gap = (i: number) => placed[i + 1]!.y - placed[i]!.y;
    // Moreton->Dorchester is ~7mi on one ELR, Upwey->Weymouth ~2.5mi on another.
    expect(gap(0)).toBeGreaterThan(gap(2));
    // The ELR boundary must not read as the biggest hop on the corridor.
    expect(gap(1)).toBeLessThan(gap(0));
    expect(placed[2]!.elr).toBe("BML3");
  });

  it("still descends when mileage runs the other way", () => {
    const reversed = positions.map((p) => ({ ...p, mileage: 100 - p.mileage }));
    const stations = [...swml.stations].reverse();
    const placed = placeStations(stations, reversed);
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!.y).toBeGreaterThan(placed[i - 1]!.y);
    }
  });
});

describe("placeTracks", () => {
  // Stations as the layout places them: a y, a mileage and the ELR that
  // mileage is measured on. A corridor crosses several ELRs, so the ELR is
  // what makes a mileage meaningful.
  const points = [
    { y: 240, mile: 0, elr: "MLN1" },
    { y: 500, mile: 24.4, elr: "MLN1" },
    { y: 900, mile: 47.75, elr: "MLN1" },
    { y: 1300, mile: 66.6, elr: "MLN1" },
  ];
  const tracks = placeTracks(MLN1, points, trackRoleName);

  it("draws the four SWML running lines", () => {
    expect(tracks.map((t) => t.trackId).sort()).toEqual(["1100", "1200", "2100", "2200"]);
  });

  it("names them rather than showing raw ids", () => {
    const byId = new Map(tracks.map((t) => [t.trackId, t.label]));
    expect(byId.get("1100")).toBe("Down Fast");
    expect(byId.get("2100")).toBe("Up Fast");
  });

  it("puts up lines left of down lines", () => {
    const up = tracks.filter((t) => t.trackId.startsWith("2"));
    const down = tracks.filter((t) => t.trackId.startsWith("1"));
    expect(Math.max(...up.map((t) => t.x))).toBeLessThan(Math.min(...down.map((t) => t.x)));
  });

  it("gives each column a distinct x", () => {
    expect(new Set(tracks.map((t) => t.x)).size).toBe(tracks.length);
  });

  it("ends the slow pair above the fast pair", () => {
    // The four-track railway stops at Worting Jn; the mains carry on to
    // Weymouth, so the slow lines stop higher up the page.
    const slow = tracks.find((t) => t.trackId === "1200")!;
    const fast = tracks.find((t) => t.trackId === "1100")!;
    expect(slow.toY).toBeLessThan(fast.toY);
  });

  it("returns nothing when there are no sections", () => {
    expect(placeTracks([], points, trackRoleName)).toEqual([]);
  });

  it("ignores stations on a different ELR", () => {
    // Mileage restarts per ELR, so a BML2 mileage must never be measured
    // against MLN1 sections.
    const other = placeTracks(MLN1, [{ y: 240, mile: 10, elr: "BML2" }], trackRoleName);
    expect(other).toEqual([]);
  });
});

describe("waterlooPlatformGroup", () => {
  it("assigns platforms to the lines they really feed", () => {
    // The old renderer cycled platforms through lanes with a modulo, which put
    // adjacent platforms on unrelated lines.
    expect(waterlooPlatformGroup(1)).toBe("windsor");
    expect(waterlooPlatformGroup(4)).toBe("windsor");
    expect(waterlooPlatformGroup(5)).toBe("main");
    expect(waterlooPlatformGroup(19)).toBe("main");
    expect(waterlooPlatformGroup(20)).toBe("windsor");
    expect(waterlooPlatformGroup(24)).toBe("windsor");
  });

  it("has no opinion about platforms that do not exist", () => {
    expect(waterlooPlatformGroup(0)).toBeUndefined();
    expect(waterlooPlatformGroup(25)).toBeUndefined();
  });
});
