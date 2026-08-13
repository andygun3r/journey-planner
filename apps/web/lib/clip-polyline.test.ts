import { describe, expect, it } from "vitest";
import { clipPolyline } from "./journeys";

/**
 * Clips a TfL line's published route sequence down to the stretch a single
 * leg actually travels. Used when a journey leg arrives without its own
 * `path.lineString` (TfL omits it on some legs, notably buses).
 *
 * The risk being guarded here is drawing a confidently wrong line — the whole
 * route instead of one leg, or the wrong branch entirely.
 */
const LINE: [number, number][] = [
  [-0.1, 51.5],
  [-0.2, 51.5],
  [-0.3, 51.5],
  [-0.4, 51.5],
  [-0.5, 51.5],
];

describe("clipPolyline", () => {
  it("returns only the stretch between the two stops", () => {
    const clipped = clipPolyline(LINE, [-0.2, 51.5], [-0.4, 51.5]);
    expect(clipped).toEqual([
      [-0.2, 51.5],
      [-0.3, 51.5],
      [-0.4, 51.5],
    ]);
  });

  it("reverses when the leg runs against the sequence's direction", () => {
    // Route sequences are published per-direction; a leg may travel either way.
    const clipped = clipPolyline(LINE, [-0.4, 51.5], [-0.2, 51.5]);
    expect(clipped).toEqual([
      [-0.4, 51.5],
      [-0.3, 51.5],
      [-0.2, 51.5],
    ]);
  });

  it("snaps to the nearest vertex when a stop is set back from the centreline", () => {
    const clipped = clipPolyline(LINE, [-0.203, 51.502], [-0.398, 51.499]);
    expect(clipped).toHaveLength(3);
    expect(clipped![0]).toEqual([-0.2, 51.5]);
  });

  it("returns null when a stop is nowhere near this line", () => {
    // Wrong branch, or the wrong line entirely — draw nothing rather than a lie.
    expect(clipPolyline(LINE, [-0.2, 51.5], [1.5, 53.0])).toBeNull();
  });

  it("returns null when both ends snap to the same vertex", () => {
    // A zero-length clip isn't a route; it's a dot.
    expect(clipPolyline(LINE, [-0.3, 51.5], [-0.301, 51.5])).toBeNull();
  });

  it("returns null for a degenerate line", () => {
    expect(clipPolyline([[-0.1, 51.5]], [-0.1, 51.5], [-0.2, 51.5])).toBeNull();
    expect(clipPolyline([], [-0.1, 51.5], [-0.2, 51.5])).toBeNull();
  });

  it("keeps the full line when the stops are its endpoints", () => {
    const clipped = clipPolyline(LINE, [-0.1, 51.5], [-0.5, 51.5]);
    expect(clipped).toEqual(LINE);
  });
});
