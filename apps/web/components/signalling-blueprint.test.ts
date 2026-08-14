import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveSections } from "@signaller/shared";
import { describe, expect, it } from "vitest";
import { CorridorBlueprint } from "./signalling-diagram";
import {
  BLUEPRINT_TOP,
  CRS_COLUMN_X,
  LABEL_GUTTER,
  buildBlueprint,
} from "@/lib/blueprint-layout";
import { SIGNALLING_CORRIDORS, trackRoleName } from "@/lib/signalling-corridors";
import spans from "@/lib/__fixtures__/mln1-track-spans.json";

/**
 * Layout invariants for the vertical blueprint.
 *
 * These exist because the first working version of this renderer had four
 * separate collision bugs that typechecked, passed every unit test and only
 * showed up when the SVG was actually rendered and looked at: long station
 * names ran through the CRS column, left-hand branch labels sat on top of
 * station names, right-hand branch labels fell outside the viewBox, and
 * Waterloo's platform stubs crossed each other into a lattice. Each assertion
 * below is one of those bugs.
 */
const sections = deriveSections("MLN1", spans);
const positions = [
  { crs: "WAT", elr: "MLN1", mileage: 0.0 },
  { crs: "CLJ", elr: "MLN1", mileage: 3.61 },
  { crs: "WOK", elr: "MLN1", mileage: 24.3 },
  { crs: "BSK", elr: "MLN1", mileage: 47.6 },
  { crs: "WIN", elr: "MLN1", mileage: 66.5 },
  { crs: "WEY", elr: "MLN1", mileage: 142.4 },
];

const model = buildBlueprint({
  corridor: SIGNALLING_CORRIDORS.swml!,
  positions,
  sections,
  berths: [],
  nameFor: trackRoleName,
});

const svg = renderToStaticMarkup(
  createElement(CorridorBlueprint, {
    model,
    trainsByStation: new Map([
      [
        "WOK",
        [
          {
            headcode: "1A23",
            berthId: "b1",
            focus: false,
            berth: { id: "b1", tdArea: "SU", berth: "0123", platform: "3", x: 0, y: 0 },
          },
        ],
      ],
      [
        "BSK",
        [
          {
            headcode: "2B45",
            berthId: "b2",
            focus: false,
            // No platform: line genuinely unknown.
            berth: { id: "b2", tdArea: "SU", berth: "0456", x: 0, y: 0 },
          },
        ],
      ],
    ]) as never,
    signalCounts: new Map([["WOK", { off: 2, red: 1, unknown: 0, routeSet: 1 }]]),
  } as never),
);

describe("blueprint layout", () => {
  it("is taller than it is wide — it reads down the corridor", () => {
    expect(model.height).toBeGreaterThan(model.width * 3);
  });

  it("keeps every drawn x inside the viewBox", () => {
    // Branch labels are the widest thing on the diagram and used to be clipped.
    const xs = [...svg.matchAll(/\bx="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(model.width);
  });

  it("keeps every drawn y inside the viewBox", () => {
    const ys = [...svg.matchAll(/\by="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(model.height);
  });

  it("leaves the station-name gutter clear of the running lines", () => {
    // Names are drawn from BLUEPRINT_LABEL_X; the CRS column and then the
    // tracks follow. A name long enough to reach the CRS column is the bug.
    const longest = Math.max(
      ...SIGNALLING_CORRIDORS.swml!.stations.map((s) => s.name.length),
    );
    // ~6px per character at the 9.5px monospace label size, plus the 20px inset.
    expect(20 + longest * 6).toBeLessThan(CRS_COLUMN_X);
    expect(CRS_COLUMN_X).toBeLessThan(LABEL_GUTTER);
  });

  it("puts every branch spur to the right of the running lines", () => {
    // Branches used to alternate sides, and the left-hand ones ran straight
    // through the station names.
    const trackRight = Math.max(...model.tracks.map((t) => t.x));
    const nodes = [...svg.matchAll(/<circle cx="([\d.]+)"[^>]*sig-blueprint-branch-node/g)];
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(Number(n[1])).toBeGreaterThan(trackRight);
  });

  it("draws Waterloo's 24 platforms without crossing them", () => {
    // Each stub runs from its own x down to a target column. Sorted by start x,
    // the targets must never go backwards, or stubs cross each other.
    const fans = [...svg.matchAll(/d="M ([\d.]+) [\d.]+ L [^C]+C [^,]+, ([\d.]+) [\d.]+, ([\d.]+) /g)];
    expect(fans).toHaveLength(24);
    const targets = fans
      .map((f) => ({ start: Number(f[1]), target: Number(f[3]) }))
      .sort((a, b) => a.start - b.start)
      .map((f) => f.target);
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i]).toBeGreaterThanOrEqual(targets[i - 1]!);
    }
  });

  it("starts the first station below the header band", () => {
    // The throat and the running-line labels stack above it.
    expect(model.stations[0]!.y).toBe(BLUEPRINT_TOP);
    expect(BLUEPRINT_TOP).toBeGreaterThan(150);
  });

  it("marks a train whose running line is unknown", () => {
    expect(svg).toContain("sig-berth-unplaced");
    expect(svg).toContain("running line unknown");
  });

  it("does not mark a train whose line could be inferred", () => {
    expect(svg).toContain("line inferred from platform 3");
  });

  it("says when a station's position is estimated", () => {
    expect(svg).toContain("position estimated");
  });

  it("gives every <title> a single text child", () => {
    // React silently drops multi-part <title> children, which killed every
    // tooltip on the diagram until the strings were templated.
    for (const t of svg.matchAll(/<title>(.*?)<\/title>/g)) {
      expect(t[1]).not.toContain("<");
    }
  });
});
