import { describe, expect, it } from "vitest";
import { walkLabel } from "../components/map-shell";

/**
 * Walking legs only carry distance/duration once street routing is enabled
 * (an OSM extract imported into MOTIS). The label has to read sensibly both
 * before and after that switch, since the same component renders both.
 */
describe("walkLabel", () => {
  it("shows duration and distance when the engine supplies them", () => {
    expect(walkLabel({ durationSeconds: 480, distanceMeters: 650 })).toBe("Walk · 8 min · 650m");
  });

  it("falls back to a bare 'Walk' with no street routing", () => {
    // Transit-only MOTIS reports neither field; the leg is still real.
    expect(walkLabel({})).toBe("Walk");
  });

  it("rounds to the nearest 50m, since pavement routing is not metre-accurate", () => {
    expect(walkLabel({ distanceMeters: 652 })).toBe("Walk · 650m");
    expect(walkLabel({ distanceMeters: 676 })).toBe("Walk · 700m");
  });

  it("switches to kilometres past 1km", () => {
    expect(walkLabel({ distanceMeters: 1500 })).toBe("Walk · 1.5km");
  });

  it("never shows a zero-minute walk", () => {
    // A 20-second walk is still a walk; "0 min" reads as a bug.
    expect(walkLabel({ durationSeconds: 20 })).toBe("Walk · 1 min");
  });

  it("ignores zero values rather than printing '0m'", () => {
    expect(walkLabel({ durationSeconds: 0, distanceMeters: 0 })).toBe("Walk");
  });
});
