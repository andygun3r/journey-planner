import { describe, expect, it } from "vitest";
import { nearestPosition, sheetHeightFraction, stepPosition } from "./map-sheet";

describe("nearestPosition", () => {
  it("snaps to the closest rest position", () => {
    expect(nearestPosition(0.18)).toBe("peek");
    expect(nearestPosition(0.5)).toBe("half");
    expect(nearestPosition(0.9)).toBe("full");
  });

  it("snaps a part-way drag to whichever position it is nearer", () => {
    expect(nearestPosition(0.25)).toBe("peek");
    expect(nearestPosition(0.4)).toBe("half");
    expect(nearestPosition(0.75)).toBe("full");
  });

  it("clamps beyond either end rather than returning nothing", () => {
    // A fast flick can overshoot the container; it still has to land somewhere.
    expect(nearestPosition(-1)).toBe("peek");
    expect(nearestPosition(5)).toBe("full");
  });
});

describe("stepPosition", () => {
  it("moves one position at a time", () => {
    expect(stepPosition("peek", 1)).toBe("half");
    expect(stepPosition("half", 1)).toBe("full");
    expect(stepPosition("full", -1)).toBe("half");
  });

  it("stops at the ends instead of wrapping", () => {
    // Arrow-key users must not jump from full back to peek unexpectedly.
    expect(stepPosition("full", 1)).toBe("full");
    expect(stepPosition("peek", -1)).toBe("peek");
  });
});

describe("sheetHeightFraction", () => {
  it("grows with each position", () => {
    expect(sheetHeightFraction("peek")).toBeLessThan(sheetHeightFraction("half"));
    expect(sheetHeightFraction("half")).toBeLessThan(sheetHeightFraction("full"));
  });

  it("always leaves some map visible, even at full", () => {
    expect(sheetHeightFraction("full")).toBeLessThan(1);
  });
});
