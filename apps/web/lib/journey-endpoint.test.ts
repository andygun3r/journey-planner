import { describe, expect, it } from "vitest";
import { encodeEndpoint, parseEndpoint, type JourneyEndpoint } from "./journey-endpoint";

/**
 * These strings are the `from`/`to` query params on /journeys, so they end up
 * in shared links and bookmarks. Parsing must stay stable and must round-trip:
 * a shape that encodes but won't parse back is a broken shared link.
 */
describe("parseEndpoint", () => {
  it("reads a bare CRS", () => {
    expect(parseEndpoint("KGX")).toEqual({ type: "crs", crs: "KGX" });
    expect(parseEndpoint("kgx")).toEqual({ type: "crs", crs: "KGX" });
  });

  it("reads GPS coordinates", () => {
    expect(parseEndpoint("geo:51.5,-0.12")).toEqual({ type: "geo", lat: 51.5, lon: -0.12 });
  });

  it("reads a postcode", () => {
    expect(parseEndpoint("postcode:SW1A 1AA")).toEqual({ type: "postcode", text: "SW1A 1AA" });
  });

  it("reads an OS Places UPRN", () => {
    expect(parseEndpoint("place:100023336956")).toEqual({ type: "place", uprn: "100023336956" });
  });

  it("rejects a non-numeric UPRN rather than passing it to the API", () => {
    // Hand-edited or corrupted links must fail here, not at the OS Places call.
    expect(parseEndpoint("place:not-a-uprn")).toBeNull();
    expect(parseEndpoint("place:")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(parseEndpoint("")).toBeNull();
    expect(parseEndpoint("geo:abc,def")).toBeNull();
  });
});

describe("encodeEndpoint", () => {
  const cases: JourneyEndpoint[] = [
    { type: "crs", crs: "KGX" },
    { type: "naptan", naptanId: "940GZZLUKSX" },
    { type: "geo", lat: 51.5, lon: -0.12 },
    { type: "postcode", text: "SW1A 1AA" },
    { type: "place", uprn: "100023336956" },
  ];

  for (const endpoint of cases) {
    it(`round-trips a ${endpoint.type} endpoint`, () => {
      expect(parseEndpoint(encodeEndpoint(endpoint))).toEqual(endpoint);
    });
  }
});
