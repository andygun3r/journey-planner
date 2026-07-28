import { describe, expect, it } from "vitest";
import { parseCallingPattern } from "./service-details";
import { londonDateKey, ukHhmm } from "./uk-time";

/**
 * `parseCallingPattern` takes the raw LDBWS GetServiceDetails payload. The type
 * is intentionally loose at the boundary (the feed is XML underneath and the
 * gateway's JSON shape varies), so these fixtures are cast in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (payload: unknown) => parseCallingPattern(payload as any);

const base = {
  generatedAt: "2026-07-15T06:00:00Z",
  locationName: "Clapham Junction",
  crs: "CLJ",
  std: "07:08",
  etd: "On time",
  platform: "12",
};

const point = (crs: string, name: string, st: string, extra: Record<string, unknown> = {}) => ({
  crs,
  locationName: name,
  st,
  ...extra,
});

describe("parseCallingPattern", () => {
  it("builds one linear route from the through portion", () => {
    const { calls, portions } = parse({
      ...base,
      previousCallingPoints: [{ callingPoint: [point("WAT", "London Waterloo", "07:00")] }],
      subsequentCallingPoints: [
        { callingPoint: [point("SUR", "Surbiton", "07:16"), point("WOK", "Woking", "07:32")] },
      ],
    });

    expect(calls.map((c) => c.crs)).toEqual(["WAT", "CLJ", "SUR", "WOK"]);
    expect(calls.find((c) => c.isThisStop)?.crs).toBe("CLJ");
    expect(portions).toEqual([]);
  });

  it("keeps a dividing service's portions OUT of the main route", () => {
    // The reported bug: every callingPointList was concatenated into one array,
    // so the second portion's stops appeared on your route — "the train passed
    // a station that's not on the route".
    const { calls, portions } = parse({
      ...base,
      subsequentCallingPoints: [
        { callingPoint: [point("SUR", "Surbiton", "07:16"), point("WOK", "Woking", "07:32")] },
        {
          callingPoint: [point("GLD", "Guildford", "07:45"), point("PMS", "Portsmouth", "08:30")],
          serviceChangeRequired: true,
        },
      ],
    });

    expect(calls.map((c) => c.crs)).toEqual(["CLJ", "SUR", "WOK"]);
    expect(calls.map((c) => c.crs)).not.toContain("GLD");
    expect(calls.map((c) => c.crs)).not.toContain("PMS");

    expect(portions).toHaveLength(1);
    expect(portions[0]).toMatchObject({
      kind: "divides",
      terminusName: "Portsmouth",
      changeRequired: true,
      cancelled: false,
    });
    expect(portions[0]!.calls.map((c) => c.crs)).toEqual(["GLD", "PMS"]);
  });

  it("captures a joining portion and its origin", () => {
    const { calls, portions } = parse({
      ...base,
      previousCallingPoints: [
        { callingPoint: [point("WAT", "London Waterloo", "07:00")] },
        { callingPoint: [point("RDG", "Reading", "06:30"), point("BSK", "Basingstoke", "06:52")] },
      ],
    });

    expect(calls.map((c) => c.crs)).toEqual(["WAT", "CLJ"]);
    expect(portions).toHaveLength(1);
    expect(portions[0]).toMatchObject({ kind: "joins", terminusName: "Reading" });
  });

  it("carries the associated portion's cancellation flag", () => {
    const { portions } = parse({
      ...base,
      subsequentCallingPoints: [
        { callingPoint: [point("SUR", "Surbiton", "07:16")] },
        { callingPoint: [point("GLD", "Guildford", "07:45")], assocIsCancelled: true },
      ],
    });
    expect(portions[0]!.cancelled).toBe(true);
  });

  it("survives a single calling point collapsed to a bare object", () => {
    // Classic XML->JSON collapse. `.flatMap` on a non-array used to throw out
    // of an unguarded parse: a 500 from the API and a crashed render.
    const { calls } = parse({
      ...base,
      previousCallingPoints: { callingPoint: point("WAT", "London Waterloo", "07:00") },
      subsequentCallingPoints: { callingPoint: point("SUR", "Surbiton", "07:16") },
    });
    expect(calls.map((c) => c.crs)).toEqual(["WAT", "CLJ", "SUR"]);
  });

  it("survives missing calling-point lists entirely", () => {
    const { calls, portions } = parse(base);
    expect(calls.map((c) => c.crs)).toEqual(["CLJ"]);
    expect(portions).toEqual([]);
  });

  it("keeps actual and estimated times in separate fields", () => {
    // Collapsing `at ?? et` into one field lost the difference between
    // "estimated 07:44" and "actually departed 07:44".
    const { calls } = parse({
      ...base,
      subsequentCallingPoints: [
        {
          callingPoint: [
            point("SUR", "Surbiton", "07:16", { at: "07:18" }),
            point("WOK", "Woking", "07:32", { et: "07:35" }),
          ],
        },
      ],
    });
    const sur = calls.find((c) => c.crs === "SUR")!;
    const wok = calls.find((c) => c.crs === "WOK")!;
    expect(sur.actual).toBe("07:18");
    expect(sur.expected).toBeUndefined();
    expect(wok.expected).toBe("07:35");
    expect(wok.actual).toBeUndefined();
  });

  it("resolves every scheduled time to a monotonic instant", () => {
    const { calls } = parse({
      ...base,
      subsequentCallingPoints: [
        {
          callingPoint: [point("SUR", "Surbiton", "07:16"), point("WOK", "Woking", "07:32")],
        },
      ],
    });
    const ms = calls.map((c) => Date.parse(c.scheduledIso!));
    expect(ms.every(Number.isFinite)).toBe(true);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it("dates an overnight pattern across midnight without reordering it", () => {
    const { calls } = parse({
      generatedAt: "2026-07-15T22:30:00Z", // 23:30 London
      locationName: "London Paddington",
      crs: "PAD",
      std: "23:45",
      subsequentCallingPoints: [
        {
          callingPoint: [
            point("RDG", "Reading", "00:20"),
            point("SWI", "Swindon", "01:05"),
            point("BRI", "Bristol Temple Meads", "01:40"),
          ],
        },
      ],
    });
    const ms = calls.map((c) => Date.parse(c.scheduledIso!));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(ukHhmm(calls[0]!.scheduledIso)).toBe("23:45");
    expect(ukHhmm(calls[3]!.scheduledIso)).toBe("01:40");
    // ...and the post-midnight stops land on the following London date.
    expect(londonDateKey(new Date(calls[0]!.scheduledIso!))).toBe("2026-07-15");
    expect(londonDateKey(new Date(calls[1]!.scheduledIso!))).toBe("2026-07-16");
  });

  it("keeps the boarding stop's platform from the payload", () => {
    const { calls } = parse(base);
    expect(calls[0]!.platform).toBe("12");
  });

  it("falls back to now when generatedAt is unusable", () => {
    const { calls } = parse({ ...base, generatedAt: "not-a-date" });
    expect(Number.isFinite(Date.parse(calls[0]!.scheduledIso!))).toBe(true);
  });

  it("drops an associated portion that has no calling points", () => {
    const { portions } = parse({
      ...base,
      subsequentCallingPoints: [
        { callingPoint: [point("SUR", "Surbiton", "07:16")] },
        { callingPoint: [] },
      ],
    });
    expect(portions).toEqual([]);
  });
});
