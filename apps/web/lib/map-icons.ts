"use client";

import type maplibregl from "maplibre-gl";

/**
 * Shared MapLibre SDF icons for the vehicle markers, used by both the live
 * map and the service-detail position map.
 */

export const TRAIN_ICON = "mainline-train-icon";
export const BUS_ICON = "mainline-bus-icon";
export const ARROW_ICON = "mainline-direction-arrow";
export const BERTH_PLATE_ICON = "mainline-berth-plate";

/**
 * Renders an SVG path string to an SDF (signed-distance-field) image MapLibre
 * can recolor per-feature via `icon-color` — the same trick used for the
 * on-time/late/early train dots before this became icon-based, now applied to
 * a train/bus glyph instead of a plain circle. SDF wants a single-channel
 * alpha mask, so this fills the path solid black on a transparent canvas and
 * lets MapLibre derive the distance field from the alpha channel itself
 * (that's what `sdf: true` on addImage does — no manual distance-field math
 * needed here).
 */
function rasterizeIcon(svgPath: string, viewBoxSize: number, outputSize: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(outputSize, outputSize);
  ctx.scale(outputSize / viewBoxSize, outputSize / viewBoxSize);
  ctx.fillStyle = "#000";
  ctx.fill(new Path2D(svgPath));
  return ctx.getImageData(0, 0, outputSize, outputSize);
}

// Front-facing train glyph — the same path already used in the train detail
// panel's "approaching" marker (train-detail-panel.tsx), so the map icon and
// the panel icon read as the same symbol.
const TRAIN_ICON_PATH =
  "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4Zm-6 6h5v4H6V8Zm7 0h5v4h-5V8Zm-4.5 9A1.5 1.5 0 1 1 10 15.5 1.5 1.5 0 0 1 8.5 17Zm7 0A1.5 1.5 0 1 1 17 15.5 1.5 1.5 0 0 1 15.5 17Z";

// Simple front-facing bus glyph in the same visual weight as the train icon.
const BUS_ICON_PATH =
  "M4 5.5C4 3 6.5 2 12 2s8 1 8 3.5v11A2.5 2.5 0 0 1 17.5 19H17l1 2h-2l-1-2H9l-1 2H6l1-2h-.5A2.5 2.5 0 0 1 4 16.5Zm2.5 2.5v5h11v-5ZM7 15.5A1.5 1.5 0 1 0 8.5 17 1.5 1.5 0 0 0 7 15.5Zm10 0A1.5 1.5 0 1 0 18.5 17 1.5 1.5 0 0 0 17 15.5Z";

// A short arrowhead that sits just past the badge's edge (see the
// *-arrow layers' icon-offset) and gets `icon-rotate`d per-feature — the
// "arrow poking out of the circle" pointing along direction of travel.
const ARROW_ICON_PATH = "M9 0 L15.5 11 L9 8.5 L2.5 11 Z";
const BERTH_PLATE_PATH = "M3 5 Q3 3 5 3 H27 Q29 3 29 5 V15 Q29 17 27 17 H5 Q3 17 3 15 Z";
const ARROW_RASTER_SIZE = 64;

/**
 * `icon-offset` is measured in ems of the icon's own *rendered* size, not
 * pixels — an earlier version assumed pixels outright (offset -34, which
 * placed the arrow ~34 icon-widths away, invisible off past the tile it was
 * drawn in) and a later fix still undershot by an arbitrary /2. This computes
 * the em value needed to push the arrow's center `pastPx` pixels beyond the
 * badge's edge: (badgeRadius + pastPx) converted into the arrow's own
 * rendered-size units, negative because -y is "up/outward" before rotation
 * (icon-rotate then turns that "up" to point along the real bearing).
 */
export function arrowOffsetEms(badgeRadius: number, arrowIconSize: number, pastPx = 4): number {
  const arrowRenderedPx = arrowIconSize * ARROW_RASTER_SIZE;
  return -(badgeRadius + pastPx) / arrowRenderedPx;
}

export function addMapIcons(map: maplibregl.Map): void {
  const size = 64;
  if (!map.hasImage(TRAIN_ICON)) {
    map.addImage(TRAIN_ICON, rasterizeIcon(TRAIN_ICON_PATH, 24, size), { sdf: true });
  }
  if (!map.hasImage(BUS_ICON)) {
    map.addImage(BUS_ICON, rasterizeIcon(BUS_ICON_PATH, 24, size), { sdf: true });
  }
  if (!map.hasImage(ARROW_ICON)) {
    map.addImage(ARROW_ICON, rasterizeIcon(ARROW_ICON_PATH, 18, size), { sdf: true });
  }
  if (!map.hasImage(BERTH_PLATE_ICON)) {
    map.addImage(BERTH_PLATE_ICON, rasterizeIcon(BERTH_PLATE_PATH, 32, size), { sdf: true });
  }
}

/** Badge colour by lateness bucket — shared so both maps encode status identically. */
export const lateBucketColor: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "lateBucket"],
  "ontime",
  "#076d3a",
  "late",
  "#d4202c",
  "early",
  "#0033a0",
  "#5c6070",
];
