import { describe, expect, it } from "vitest";
import { isIsoDate, isUuid } from "./route-params";

/**
 * These guards exist because of two real 500s: the native client can put any
 * string in a URL path, and Postgres answers a malformed uuid with
 * `22P02 invalid input syntax` rather than an empty result. The web UI never
 * hit it because it only ever links ids it just read from the database.
 */

describe("isUuid", () => {
  it("accepts a real commute id", () => {
    expect(isUuid("72fa45e3-c0a4-46c1-967e-71c7d192732f")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUuid("72FA45E3-C0A4-46C1-967E-71C7D192732F")).toBe(true);
  });

  it("rejects the strings that caused the 500s", () => {
    expect(isUuid("does-not-exist")).toBe(false);
    expect(isUuid("x")).toBe(false);
  });

  it("rejects near-misses", () => {
    // Too short in the last group.
    expect(isUuid("72fa45e3-c0a4-46c1-967e-71c7d192732")).toBe(false);
    // Non-hex character.
    expect(isUuid("72fa45e3-c0a4-46c1-967e-71c7d192732g")).toBe(false);
    // No hyphens.
    expect(isUuid("72fa45e3c0a446c1967e71c7d192732f")).toBe(false);
  });

  it("rejects empty and nullish input", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("isIsoDate", () => {
  it("accepts a real date", () => {
    expect(isIsoDate("2026-09-14")).toBe(true);
  });

  it("accepts a leap day in a leap year", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("rejects dates that match the shape but do not exist", () => {
    // The regex alone would let both of these through, and Date would silently
    // roll them forward into the next month.
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("rejects other formats", () => {
    expect(isIsoDate("14/09/2026")).toBe(false);
    expect(isIsoDate("2026-9-14")).toBe(false);
    expect(isIsoDate("2026-09-14T00:00:00Z")).toBe(false);
    expect(isIsoDate("not-a-date")).toBe(false);
  });

  it("rejects empty and nullish input", () => {
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});
