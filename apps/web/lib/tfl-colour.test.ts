import { describe, expect, it } from "vitest";
import { tflColour } from "@signaller/shared";

/**
 * TfL line colours are what make a drawn route readable at a glance — people
 * already know the tube map. The failure mode is subtle: returning a
 * plausible-but-wrong colour reads as correct and misleads.
 */
describe("tflColour", () => {
  it("gives each line its own official colour", () => {
    expect(tflColour("central")).toBe("#E32017");
    expect(tflColour("victoria")).toBe("#0098D4");
    expect(tflColour("piccadilly")).toBe("#003688");
  });

  it("does not collapse different lines onto one mode colour", () => {
    // The whole point: "tube" is not a colour, Central and Victoria are.
    expect(tflColour("central", "tube")).not.toBe(tflColour("victoria", "tube"));
  });

  it("prefers the line over the mode when both are known", () => {
    expect(tflColour("central", "tube")).toBe("#E32017");
  });

  it("is case-insensitive, since line ids vary across TfL endpoints", () => {
    expect(tflColour("Central")).toBe(tflColour("central"));
  });

  it("falls back to the mode colour for a line with no colour of its own", () => {
    // Individual bus routes have no colour; the mode does.
    expect(tflColour("N29", "bus")).toBe("#E32017");
  });

  it("knows the individually-named Overground lines", () => {
    // Renamed and recoloured in 2024 — "london-overground" orange is no
    // longer the whole story.
    expect(tflColour("mildmay")).toBe("#0077AD");
    expect(tflColour("windrush")).toBe("#ED1B00");
    expect(tflColour("london-overground")).toBe("#EE7C0E");
  });

  it("returns null rather than guessing when nothing is known", () => {
    // Callers pick their own default; a wrong colour is worse than none.
    expect(tflColour("no-such-line")).toBeNull();
    expect(tflColour(undefined, "no-such-mode")).toBeNull();
    expect(tflColour()).toBeNull();
  });
});
