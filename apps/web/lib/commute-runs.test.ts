import { describe, expect, it } from "vitest";
import { resolveActiveLegForCommute } from "@signaller/shared";
import { type CommuteRun, runHasArrived } from "./commute-runs";

const run = (over: Partial<CommuteRun> = {}): CommuteRun => ({
  id: "run-1",
  commuteId: "c-1",
  commuteLegId: "leg-1",
  serviceDate: "2026-08-11",
  direction: "am",
  originCrs: "SUR",
  originLabel: "Surbiton",
  destCrs: "WAT",
  destLabel: "London Waterloo",
  journey: null,
  scheduledArrival: "2026-08-11T08:40:00Z",
  startedAt: "2026-08-11T08:00:00Z",
  ...over,
});

describe("runHasArrived", () => {
  it("is false while the train is still running", () => {
    expect(runHasArrived(run(), new Date("2026-08-11T08:20:00Z"))).toBe(false);
  });

  it("is true once the arrival time has passed", () => {
    expect(runHasArrived(run(), new Date("2026-08-11T08:41:00Z"))).toBe(true);
  });

  it("is true exactly at the arrival time", () => {
    expect(runHasArrived(run(), new Date("2026-08-11T08:40:00Z"))).toBe(true);
  });

  it("never auto-ends a run with no known arrival — the grace window handles those", () => {
    const noArrival = run({ scheduledArrival: null });
    expect(runHasArrived(noArrival, new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });

  it("ignores an unparseable arrival rather than ending the run instantly", () => {
    const bad = run({ scheduledArrival: "not-a-date" });
    expect(runHasArrived(bad, new Date("2026-08-11T08:41:00Z"))).toBe(false);
  });
});

/**
 * The behaviour a run exists to correct. Schedule resolution is time-driven, so
 * it moves on the moment the morning window closes — correct for an idle
 * dashboard, wrong for someone still on the train. These pin the underlying
 * flip so it's clear what the run is overriding.
 */
describe("schedule resolution flips direction when the AM window ends", () => {
  const commute = { id: "c-1", label: "Office", homeCrs: "SUR", homeLabel: "Surbiton", priority: 0 };
  const legs = [
    {
      id: "leg-1",
      // 2026-08-11 is a Tuesday; dayOfWeek 0 = Monday, so Tuesday is 1.
      dayOfWeek: 1,
      workCrs: "WAT",
      workLabel: "Waterloo",
      amWindowStart: "07:00",
      amWindowEnd: "09:00",
      pmWindowStart: "17:00",
      pmWindowEnd: "19:00",
      backupWorkCrs: null,
      backupHomeCrs: null,
      backupNote: null,
      amOriginCrs: null,
      amOriginLabel: null,
      amDestCrs: null,
      amDestLabel: null,
      pmOriginCrs: null,
      pmOriginLabel: null,
      pmDestCrs: null,
      pmDestLabel: null,
      pins: [],
    },
  ];

  it("resolves AM inside the morning window", () => {
    const leg = resolveActiveLegForCommute(commute, legs, [], new Date("2026-08-11T07:30:00+01:00"));
    expect(leg?.direction).toBe("am");
    expect(leg?.destCrs).toBe("WAT");
  });

  it("has already switched to PM one minute after the AM window closes", () => {
    // A user who boarded at 08:55 is still on that train at 09:01. Without a
    // run, the dashboard is now showing them the journey home.
    const leg = resolveActiveLegForCommute(commute, legs, [], new Date("2026-08-11T09:01:00+01:00"));
    expect(leg?.direction).toBe("pm");
    expect(leg?.destCrs).toBe("SUR");
  });
});
