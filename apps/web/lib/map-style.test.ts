import { describe, expect, it } from "vitest";
import {
  absolutizeStyle,
  compositeStyle,
  groundOnlyBasemap,
  type MapStyle,
} from "@signaller/shared";

/**
 * Guards the basemap/rail style merge. The failure modes here are silent and
 * expensive: a duplicate layer id or an unresolved font makes MapLibre drop
 * features without an error, and a wrong layer order buries the rail overlay
 * under the basemap.
 */

function railStyle(): MapStyle {
  return {
    version: 8,
    sources: { railway: { type: "vector", url: "/railway.json" } },
    sprite: [{ id: "default", url: "/sprite/symbols" }],
    glyphs: "/font/{fontstack}/{range}.pbf",
    layers: [
      { id: "track", type: "line", source: "railway" },
      {
        id: "station-label",
        type: "symbol",
        source: "railway",
        layout: { "text-font": ["OpenRailwayMap-Regular"] },
      },
    ],
  };
}

function basemapStyle(): MapStyle {
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "https://tiles.example/planet" } },
    sprite: "https://tiles.example/sprite",
    glyphs: "https://tiles.example/fonts/{fontstack}/{range}.pbf",
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#111111" } },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        paint: { "fill-color": "#0000ff" },
      },
      {
        id: "place-label",
        type: "symbol",
        source: "openmaptiles",
        layout: { "text-font": ["Noto Sans Bold"], "icon-image": "dot" },
        paint: { "text-color": "#ff00ff" },
      },
    ],
  };
}

describe("absolutizeStyle", () => {
  it("resolves relative source, sprite and glyph paths against the tile origin", () => {
    const style = absolutizeStyle(railStyle(), "https://rail.example");
    expect(style.sources.railway!.url).toBe("https://rail.example/railway.json");
    expect(style.glyphs).toBe("https://rail.example/font/{fontstack}/{range}.pbf");
    expect((style.sprite as Array<{ url: string }>)[0]!.url).toBe(
      "https://rail.example/sprite/symbols",
    );
  });

  it("leaves already-absolute URLs untouched", () => {
    const style = absolutizeStyle(basemapStyle(), "https://rail.example");
    expect(style.sources.openmaptiles!.url).toBe("https://tiles.example/planet");
  });
});

describe("compositeStyle", () => {
  it("draws the basemap underneath every rail layer", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    const lastBasemap = merged.layers.map((l) => l.id.startsWith("basemap-")).lastIndexOf(true);
    const firstRail = merged.layers.findIndex((l) => !l.id.startsWith("basemap-"));
    expect(lastBasemap).toBeLessThan(firstRail);
  });

  it("keeps every layer id unique", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    expect(new Set(merged.layers.map((l) => l.id)).size).toBe(merged.layers.length);
  });

  it("points every layer at a source that exists", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    const orphans = merged.layers.filter((l) => l.source && !merged.sources[l.source]);
    expect(orphans).toEqual([]);
  });

  it("keeps the rail style's sprite and glyphs, since its layers name them", () => {
    const rail = absolutizeStyle(railStyle(), "https://rail.example");
    const merged = compositeStyle(rail, basemapStyle());
    expect(merged.glyphs).toBe("https://rail.example/font/{fontstack}/{range}.pbf");
    expect(merged.sprite).toEqual(rail.sprite);
  });

  it("remaps basemap fonts onto the rail glyph server, preserving weight", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    const label = merged.layers.find((l) => l.id === "basemap-place-label")!;
    // "Noto Sans Bold" would 404 on the rail font server; bold must stay bold.
    expect(label.layout!["text-font"]).toEqual(["OpenRailwayMap-Bold"]);
  });

  it("drops basemap icons, which have no sprite on the rail server", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    const label = merged.layers.find((l) => l.id === "basemap-place-label")!;
    expect(label.layout!["icon-image"]).toBeUndefined();
  });

  it("credits the basemap, which ships no attribution of its own", () => {
    // ODbL requires OSM credit; OpenFreeMap's style omits it, so dropping this
    // would leave us using the data uncredited.
    const merged = compositeStyle(railStyle(), basemapStyle());
    const attributions = Object.entries(merged.sources)
      .filter(([id]) => id.startsWith("basemap-"))
      .map(([, s]) => s.attribution)
      .filter(Boolean);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toContain("OpenStreetMap");
  });

  it("keeps a basemap source's own attribution when it has one", () => {
    const basemap = basemapStyle();
    basemap.sources.openmaptiles!.attribution = "© Someone Else";
    const merged = compositeStyle(railStyle(), basemap);
    expect(merged.sources["basemap-openmaptiles"]!.attribution).toBe("© Someone Else");
  });

  it("retints the basemap to the Platform White palette", () => {
    const merged = compositeStyle(railStyle(), basemapStyle());
    const background = merged.layers.find((l) => l.id === "basemap-background")!;
    // The basemap's own near-black background would fight the light ground.
    expect(background.paint!["background-color"]).toBe("#f6f4f0");
    const water = merged.layers.find((l) => l.id === "basemap-water")!;
    expect(water.paint!["fill-color"]).not.toBe("#0000ff");
  });
});

describe("groundOnlyBasemap", () => {
  it("still composites into a valid style when the basemap is unavailable", () => {
    const merged = compositeStyle(railStyle(), groundOnlyBasemap());
    expect(merged.layers.some((l) => l.type === "background")).toBe(true);
    expect(merged.layers.filter((l) => l.source && !merged.sources[l.source])).toEqual([]);
  });
});
