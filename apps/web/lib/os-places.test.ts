import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { osPlacesConfigured, placeByUprn, searchPlaces } from "./os-places";

/**
 * OS Places is optional: it needs an OS Data Hub key, and there isn't one in
 * every environment. When it's absent the destination box must still find
 * stations and postcodes — place search is an enhancement, never a dependency.
 * These tests pin that "unconfigured is a normal state" contract.
 */
describe("OS Places when no key is configured", () => {
  const saved = process.env.OS_PLACES_API_KEY;

  beforeEach(() => {
    delete process.env.OS_PLACES_API_KEY;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.OS_PLACES_API_KEY;
    else process.env.OS_PLACES_API_KEY = saved;
  });

  it("reports itself unconfigured", () => {
    expect(osPlacesConfigured()).toBe(false);
  });

  it("treats a blank key as unset, not as a usable credential", () => {
    // A key line copied from .env.example with nothing filled in is "unset".
    process.env.OS_PLACES_API_KEY = "   ";
    expect(osPlacesConfigured()).toBe(false);
  });

  it("returns no places rather than throwing into a 500", async () => {
    await expect(searchPlaces("The Shard")).resolves.toEqual([]);
  });

  it("resolves no UPRN rather than throwing", async () => {
    await expect(placeByUprn("100023336956")).resolves.toBeNull();
  });
});

describe("searchPlaces input guards", () => {
  it("does not call out for a query too short to be meaningful", async () => {
    // Guards a metered API against a request on every early keystroke.
    process.env.OS_PLACES_API_KEY = "test-key";
    await expect(searchPlaces("th")).resolves.toEqual([]);
    delete process.env.OS_PLACES_API_KEY;
  });
});
