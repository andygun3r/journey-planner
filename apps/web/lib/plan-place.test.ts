import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotisEngine } from "@signaller/routing-adapter";

/**
 * Door-to-door routing depends on two things being encoded exactly right in
 * the MOTIS request, and both fail silently if wrong: a coordinate must not
 * be treated as a stop id, and street-routing params must not be sent to a
 * transit-only engine that doesn't understand them.
 */
describe("MotisEngine.plan place encoding", () => {
  const original = globalThis.fetch;
  let lastUrl = "";

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      lastUrl = url.toString();
      return new Response(JSON.stringify({ itineraries: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = original;
  });

  function params(): URLSearchParams {
    return new URL(lastUrl).searchParams;
  }

  const engine = new MotisEngine("http://stub");

  it("prefixes a CRS with the dataset tag", async () => {
    await engine.plan({ from: "KGX", to: "YRK" });
    expect(params().get("fromPlace")).toBe("gb-railgtfs_KGX");
    expect(params().get("toPlace")).toBe("gb-railgtfs_YRK");
  });

  it("sends a coordinate as bare lat,lon — never tag-prefixed", async () => {
    // "gb-railgtfs_51.5,-0.08" is not a stop id and not a coordinate; MOTIS
    // would simply fail to find it, and door-to-door would silently break.
    await engine.plan({ from: "KGX", to: { lat: 51.5045, lon: -0.0865 } });
    expect(params().get("toPlace")).toBe("51.5045,-0.0865");
  });

  it("sends access modes and a walking cap when asked", async () => {
    await engine.plan({ from: "KGX", to: "YRK", accessModes: ["WALK"], maxAccessMinutes: 30 });
    expect(params().get("preTransitModes")).toBe("WALK");
    expect(params().get("postTransitModes")).toBe("WALK");
    expect(params().get("maxPreTransitTime")).toBe("1800");
  });

  it("omits street-routing params entirely when not asked", async () => {
    // A transit-only engine (no OSM imported) must see exactly the request it
    // saw before street routing existed.
    await engine.plan({ from: "KGX", to: "YRK" });
    expect(params().has("preTransitModes")).toBe(false);
    expect(params().has("maxPreTransitTime")).toBe(false);
  });
});
