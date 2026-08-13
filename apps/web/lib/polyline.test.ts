import { describe, expect, it } from "vitest";
import { decodePolyline } from "@signaller/routing-adapter";

/**
 * Guards the encoded-polyline decoder in packages/routing-adapter, which turns
 * MOTIS leg shapes into the [lon, lat] pairs the map draws. It's bit-level
 * code, and a silent error here puts journey lines in the wrong country.
 */
describe("decodePolyline", () => {
  it("decodes the canonical Google example", () => {
    // `_p~iF~ps|U_ulLnnqC_mqNvxq`@` is the documented reference string, which
    // decodes to (38.5,-120.2), (40.7,-120.95), (43.252,-126.453).
    const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(coords).toHaveLength(3);
    // Emitted [lon, lat], flipped from the wire order.
    expect(coords[0]![0]).toBeCloseTo(-120.2, 5);
    expect(coords[0]![1]).toBeCloseTo(38.5, 5);
    expect(coords[2]![0]).toBeCloseTo(-126.453, 5);
    expect(coords[2]![1]).toBeCloseTo(43.252, 5);
  });

  it("honours a precision of 6, which MOTIS commonly emits", () => {
    // Same deltas at precision 6 land at a tenth of the precision-5 values.
    const p5 = decodePolyline("_p~iF~ps|U", 5);
    const p6 = decodePolyline("_p~iF~ps|U", 6);
    expect(p6[0]![1]).toBeCloseTo(p5[0]![1] / 10, 6);
    expect(p6[0]![0]).toBeCloseTo(p5[0]![0] / 10, 6);
  });

  it("returns nothing for an empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("keeps the points that decoded cleanly when input is truncated", () => {
    // A trailing partial varint must not throw or loop forever — a broken tail
    // should cost us the last point, not the whole journey line.
    const full = decodePolyline("_p~iF~ps|U_ulLnnqC");
    const truncated = decodePolyline("_p~iF~ps|U_ulL");
    expect(full).toHaveLength(2);
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toEqual(full[0]);
  });
});
