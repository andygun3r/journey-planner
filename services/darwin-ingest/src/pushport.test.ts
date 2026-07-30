import { describe, expect, it } from "vitest";
import { orderScheduleLocations, parseMessage } from "./pushport.js";

/**
 * Ordering has to be right before sched_pass is worth writing at all. Passing
 * points arrive in their own array, so without this they land after every
 * intermediate stop — and the map draws its route line in seq order, so a
 * mis-placed row shows up as the line jumping backwards.
 */

const at = (tpl: string, times: { wta?: string; wtd?: string; wtp?: string }) => ({ tpl, ...times });
const order = (locs: Array<ReturnType<typeof at>>) =>
  orderScheduleLocations(locs).map((l) => l.tpl);

describe("orderScheduleLocations", () => {
  it("interleaves passing points with the stops they fall between", () => {
    // The feed's own shape: origin, then all stops, then all passing points.
    const locs = [
      at("ORIGIN", { wtd: "10:00" }),
      at("STOP_A", { wta: "10:30" }),
      at("STOP_B", { wta: "11:30" }),
      at("DEST", { wta: "12:00" }),
      at("PASS_1", { wtp: "10:15" }),
      at("PASS_2", { wtp: "11:00" }),
    ];
    expect(order(locs)).toEqual([
      "ORIGIN",
      "PASS_1",
      "STOP_A",
      "PASS_2",
      "STOP_B",
      "DEST",
    ]);
  });

  it("leaves an already-ordered pattern alone", () => {
    const locs = [
      at("A", { wtd: "10:00" }),
      at("B", { wta: "10:30" }),
      at("C", { wta: "11:00" }),
    ];
    expect(order(locs)).toEqual(["A", "B", "C"]);
  });

  it("keeps a journey past midnight in one increasing sequence", () => {
    // A naive clock sort puts 00:10 first and breaks the whole route.
    const locs = [
      at("A", { wtd: "23:40" }),
      at("B", { wta: "23:55" }),
      at("C", { wta: "00:10" }),
      at("D", { wta: "01:05" }),
    ];
    expect(order(locs)).toEqual(["A", "B", "C", "D"]);
  });

  it("places a passing point correctly across midnight", () => {
    const locs = [
      at("A", { wtd: "23:40" }),
      at("B", { wta: "00:30" }),
      at("PASS", { wtp: "00:05" }),
    ];
    expect(order(locs)).toEqual(["A", "PASS", "B"]);
  });

  it("keeps untimed rows beside the stop they were listed after", () => {
    const locs = [
      at("A", { wtd: "10:00" }),
      at("UNTIMED", {}),
      at("B", { wta: "11:00" }),
    ];
    expect(order(locs)).toEqual(["A", "UNTIMED", "B"]);
  });

  it("keeps feed order for rows sharing a minute", () => {
    const locs = [
      at("FIRST", { wtd: "10:00" }),
      at("SECOND", { wta: "10:00" }),
      at("THIRD", { wta: "10:00" }),
    ];
    expect(order(locs)).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  it("returns the input untouched when nothing carries a time", () => {
    const locs = [at("A", {}), at("B", {}), at("C", {})];
    expect(order(locs)).toEqual(["A", "B", "C"]);
  });

  it("prefers arrival over departure when both are present", () => {
    // A long stand: arriving early but leaving after the next passing point.
    const locs = [
      at("ORIGIN", { wtd: "10:00" }),
      at("LONG_STAND", { wta: "10:10", wtd: "10:50" }),
      at("PASS", { wtp: "10:30" }),
    ];
    expect(order(locs)).toEqual(["ORIGIN", "LONG_STAND", "PASS"]);
  });

  it("does not mutate its input", () => {
    const locs = [at("B", { wtd: "11:00" }), at("A", { wtd: "10:00" })];
    orderScheduleLocations(locs);
    expect(locs.map((l) => l.tpl)).toEqual(["B", "A"]);
  });
});

describe("parseSchedule", () => {
  /**
   * Wraps a schedule body in the Push Port envelope parseMessage expects: a JMS
   * envelope whose `bytes` is itself a JSON string holding the update batch.
   */
  const envelope = (schedule: Record<string, unknown>) =>
    JSON.stringify({ bytes: JSON.stringify({ uR: { schedule } }) });

  it("reads wtp and orders passing points into the pattern", () => {
    const [update] = parseMessage(
      envelope({
        rid: "R1",
        uid: "U1",
        ssd: "2026-07-29",
        trainId: "1A01",
        OR: [{ tpl: "ORIGIN", wtd: "10:00" }],
        IP: [{ tpl: "STOP", wta: "11:00" }],
        PP: [{ tpl: "PASS", wtp: "10:30" }],
        DT: [{ tpl: "DEST", wta: "12:00" }],
      }),
    );

    expect(update?.kind).toBe("schedule");
    const stops = update!.kind === "schedule" ? update!.stops : [];

    // seq must follow travel order, with the passing point in the middle.
    expect(stops.map((s) => [s.tiploc, s.seq])).toEqual([
      ["ORIGIN", 0],
      ["PASS", 1],
      ["STOP", 2],
      ["DEST", 3],
    ]);

    // And the passing point now carries a time, which is the whole point.
    expect(stops.find((s) => s.tiploc === "PASS")?.wtp).toBe("10:30");
  });
});
