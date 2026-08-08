import { describe, expect, it } from "vitest";
import {
  applyDayOverride,
  type CommuteDayOverrideRecord,
  type CommuteLegPinRecord,
  type CommuteLegRecord,
  resolveActiveLegForCommute,
} from "@signaller/shared";

const pin = (direction: "am" | "pm", schedDep: string): CommuteLegPinRecord => ({
  id: `pin-${direction}-${schedDep}`,
  direction,
  sequence: 0,
  trainUid: "W12345",
  gtfsTripId: null,
  originCrs: "SUR",
  originLabel: "Surbiton",
  schedDep,
  destCrs: "WAT",
  destLabel: "London Waterloo",
  schedArr: "08:40",
  toc: "SW",
  pickedServiceDate: "2026-08-11",
});

const leg = (over: Partial<CommuteLegRecord> = {}): CommuteLegRecord => ({
  id: "leg-1",
  dayOfWeek: 1, // Tuesday
  workCrs: "WAT",
  workLabel: "Head office",
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
  ...over,
});

const override = (
  over: Partial<CommuteDayOverrideRecord> = {},
): CommuteDayOverrideRecord => ({
  date: "2026-08-11",
  skipped: false,
  workCrs: null,
  workLabel: null,
  amWindowStart: null,
  amWindowEnd: null,
  pmWindowStart: null,
  pmWindowEnd: null,
  note: null,
  ...over,
});

describe("applyDayOverride", () => {
  it("inherits every unset field from the weekly template", () => {
    const result = applyDayOverride(leg(), override());
    expect(result.workLabel).toBe("Head office");
    expect(result.amWindowStart).toBe("07:00");
    expect(result.pmWindowEnd).toBe("19:00");
  });

  it("applies only the fields the override sets", () => {
    const result = applyDayOverride(leg(), override({ amWindowStart: "09:30", amWindowEnd: "11:00" }));
    expect(result.amWindowStart).toBe("09:30");
    expect(result.amWindowEnd).toBe("11:00");
    // The evening is untouched.
    expect(result.pmWindowStart).toBe("17:00");
    expect(result.pmWindowEnd).toBe("19:00");
  });

  it("changes the work location for that date only", () => {
    const result = applyDayOverride(leg(), override({ workCrs: "CLJ", workLabel: "Client site" }));
    expect(result.workCrs).toBe("CLJ");
    expect(result.workLabel).toBe("Client site");
  });

  it("drops pins for a direction whose window moved", () => {
    // A pinned 07:42 can't be caught on a day starting at 09:30, so keeping it
    // would pin the user to a train they will miss.
    const withPins = leg({ pins: [pin("am", "07:42"), pin("pm", "17:30")] });
    const result = applyDayOverride(withPins, override({ amWindowStart: "09:30" }));
    expect(result.pins.map((p) => p.direction)).toEqual(["pm"]);
  });

  it("keeps every pin when the override only changes the work label", () => {
    const withPins = leg({ pins: [pin("am", "07:42"), pin("pm", "17:30")] });
    const result = applyDayOverride(withPins, override({ workLabel: "Client site" }));
    expect(result.pins).toHaveLength(2);
  });

  it("never mutates the leg it was given", () => {
    const original = leg({ pins: [pin("am", "07:42")] });
    applyDayOverride(original, override({ amWindowStart: "09:30", workLabel: "Elsewhere" }));
    expect(original.amWindowStart).toBe("07:00");
    expect(original.workLabel).toBe("Head office");
    expect(original.pins).toHaveLength(1);
  });
});

describe("resolveActiveLegForCommute with an override", () => {
  const commute = { id: "c-1", label: "Office", homeCrs: "SUR", homeLabel: "Surbiton", priority: 0 };
  // 2026-08-11 is a Tuesday.
  const inMorning = new Date("2026-08-11T07:30:00+01:00");

  it("behaves exactly as before when no override is passed", () => {
    const result = resolveActiveLegForCommute(commute, [leg()], [], inMorning);
    expect(result?.direction).toBe("am");
    expect(result?.windowStart).toBe("07:00");
  });

  it("uses the override's window when one is set", () => {
    const result = resolveActiveLegForCommute(
      commute,
      [leg()],
      [],
      inMorning,
      override({ amWindowStart: "07:15", amWindowEnd: "10:00" }),
    );
    expect(result?.windowStart).toBe("07:15");
    expect(result?.windowEnd).toBe("10:00");
  });

  it("resolves nothing on a skipped date", () => {
    const result = resolveActiveLegForCommute(
      commute,
      [leg()],
      [],
      inMorning,
      override({ skipped: true }),
    );
    expect(result).toBeNull();
  });

  it("sends the user to the overridden destination", () => {
    const result = resolveActiveLegForCommute(
      commute,
      [leg()],
      [],
      inMorning,
      override({ workCrs: "CLJ", workLabel: "Client site" }),
    );
    expect(result?.destCrs).toBe("CLJ");
    expect(result?.destLabel).toBe("Client site");
  });

  it("still returns nothing on a holiday, even with an override set", () => {
    const result = resolveActiveLegForCommute(
      commute,
      [leg()],
      [{ startDate: "2026-08-11", endDate: "2026-08-11" }],
      inMorning,
      override({ amWindowStart: "07:15" }),
    );
    expect(result).toBeNull();
  });
});
