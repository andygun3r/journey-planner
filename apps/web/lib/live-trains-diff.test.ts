import { describe, expect, it, vi } from "vitest";

// live-trains-source pulls in getLiveTrains, which reaches Postgres on import.
// The diff itself is pure, so stub the data layer out and test it directly.
vi.mock("./live-trains", () => ({ getLiveTrains: vi.fn() }));

import { changed, diff } from "./live-trains-source";
import type { MapTrain } from "@/components/map-types";

function train(id: string, extra: Partial<MapTrain> = {}): MapTrain {
  return { id, lat: 51, lon: -0.1, reportedAgoSeconds: 10, ...extra };
}

function mapOf(...trains: MapTrain[]): Map<string, MapTrain> {
  return new Map(trains.map((t) => [t.id, t]));
}

const AT = "2026-07-30T12:00:00.000Z";

describe("changed", () => {
  it("is false when nothing on screen differs", () => {
    expect(changed(train("A"), train("A"))).toBe(false);
  });

  it("is true when the train has moved", () => {
    expect(changed(train("A"), train("A", { lat: 52 }))).toBe(true);
  });

  it("is true when the lateness changed", () => {
    expect(changed(train("A", { latenessMinutes: 1 }), train("A", { latenessMinutes: 5 }))).toBe(
      true,
    );
  });

  it("is true when the direction arrow would point somewhere else", () => {
    expect(changed(train("A", { nextLat: 51.2 }), train("A", { nextLat: 51.9 }))).toBe(true);
  });

  // The whole point of the delta. reportedAgoSeconds climbs on every tick, so
  // counting it would mark all 800 trains changed every time and resend the lot.
  it("ignores the report age ticking up", () => {
    expect(changed(train("A", { reportedAgoSeconds: 5 }), train("A", { reportedAgoSeconds: 65 })))
      .toBe(false);
  });
});

describe("diff", () => {
  it("sends nothing when nothing changed", () => {
    const before = mapOf(train("A"), train("B"));
    const after = mapOf(train("A"), train("B"));
    const d = diff(before, after, AT);
    expect(d.upserted).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.count).toBe(2);
  });

  it("upserts new trains and moved trains, and nothing else", () => {
    const before = mapOf(train("A"), train("B", { lat: 51 }));
    const after = mapOf(train("A"), train("B", { lat: 53 }), train("C"));
    const d = diff(before, after, AT);
    expect(d.upserted.map((t) => t.id).sort()).toEqual(["B", "C"]);
    expect(d.removed).toEqual([]);
  });

  it("reports trains that have gone", () => {
    const d = diff(mapOf(train("A"), train("B")), mapOf(train("A")), AT);
    expect(d.removed).toEqual(["B"]);
    expect(d.count).toBe(1);
  });

  it("carries the generated time through so clients can age the data", () => {
    expect(diff(mapOf(), mapOf(train("A")), AT).generatedAt).toBe(AT);
  });
});
