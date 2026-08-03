import { describe, expect, it } from "vitest";
import { parseSmartCsv } from "./reference.js";

describe("parseSmartCsv", () => {
  it("loads RDG SMART CSV extracts without a header row", () => {
    const rows = parseSmartCsv("A2,B,0632,0630,89321,PLUCKLEY,A,1,,26,,,27-07-2023\n");

    expect(rows).toEqual([
      expect.objectContaining({
        TD: "A2",
        STEPTYPE: "B",
        FROMBERTH: "0632",
        TOBERTH: "0630",
        STANOX: "89321",
        EVENT: "A",
        PLATFORM: "1",
        BERTHOFFSET: "26",
      }),
    ]);
  });
});
