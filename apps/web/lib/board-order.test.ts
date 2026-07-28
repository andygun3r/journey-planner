import { describe, expect, it } from "vitest";
import { expectedDeparture, orderByExpectedDeparture, type OrderableDeparture } from "./board-order";

const dep = (
  tripId: string,
  scheduled: string,
  extra: Partial<OrderableDeparture> = {},
): OrderableDeparture => ({
  tripId,
  scheduled,
  status: "on-time",
  ...extra,
});

describe("expectedDeparture", () => {
  it("uses the live estimate when there is one", () => {
    const d = dep("a", "2026-07-15T06:00:00Z", { live: "2026-07-15T06:40:00Z", status: "delayed" });
    expect(expectedDeparture(d)).toBe(Date.parse("2026-07-15T06:40:00Z"));
  });

  it("falls back to the booked time", () => {
    expect(expectedDeparture(dep("a", "2026-07-15T06:00:00Z"))).toBe(
      Date.parse("2026-07-15T06:00:00Z"),
    );
  });

  it("keeps a cancelled service at its booked time", () => {
    const d = dep("a", "2026-07-15T06:00:00Z", {
      live: "2026-07-15T06:40:00Z",
      status: "cancelled",
    });
    expect(expectedDeparture(d)).toBe(Date.parse("2026-07-15T06:00:00Z"));
  });

  it("ignores an unparseable live value rather than sorting it to 1970", () => {
    const d = dep("a", "2026-07-15T06:00:00Z", { live: "18:42" });
    expect(expectedDeparture(d)).toBe(Date.parse("2026-07-15T06:00:00Z"));
  });
});

describe("orderByExpectedDeparture", () => {
  it("puts the next train to actually leave at the top", () => {
    // The 06:00 is 40 late, so the 06:15 will leave first.
    const rows = [
      dep("late", "2026-07-15T06:00:00Z", { live: "2026-07-15T06:40:00Z", status: "delayed" }),
      dep("ontime", "2026-07-15T06:15:00Z"),
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.map((o) => o.departure.tripId)).toEqual(["ontime", "late"]);
  });

  it("flags exactly the rows live running displaced", () => {
    const rows = [
      dep("late", "2026-07-15T06:00:00Z", { live: "2026-07-15T06:40:00Z", status: "delayed" }),
      dep("ontime", "2026-07-15T06:15:00Z"),
      dep("later", "2026-07-15T07:00:00Z"),
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.map((o) => [o.departure.tripId, o.movedFromSchedule])).toEqual([
      ["ontime", true],
      ["late", true],
      ["later", false],
    ]);
  });

  it("leaves an undisturbed board entirely unflagged", () => {
    const rows = [
      dep("a", "2026-07-15T06:00:00Z"),
      dep("b", "2026-07-15T06:15:00Z"),
      dep("c", "2026-07-15T06:30:00Z"),
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.every((o) => !o.movedFromSchedule)).toBe(true);
    expect(ordered.map((o) => o.departure.tripId)).toEqual(["a", "b", "c"]);
  });

  it("orders correctly across midnight", () => {
    // String comparison would put 00:14 before 23:47; instants do not.
    const rows = [
      dep("after", "2026-07-15T23:14:00Z"), // 00:14 London on the 16th
      dep("before", "2026-07-15T22:47:00Z"), // 23:47 London on the 15th
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.map((o) => o.departure.tripId)).toEqual(["before", "after"]);
  });

  it("keeps equal times in their original order, so refreshes don't shuffle", () => {
    const rows = [
      dep("first", "2026-07-15T06:00:00Z"),
      dep("second", "2026-07-15T06:00:00Z"),
      dep("third", "2026-07-15T06:00:00Z"),
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.map((o) => o.departure.tripId)).toEqual(["first", "second", "third"]);
    expect(ordered.every((o) => !o.movedFromSchedule)).toBe(true);
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      dep("late", "2026-07-15T06:00:00Z", { live: "2026-07-15T06:40:00Z", status: "delayed" }),
      dep("ontime", "2026-07-15T06:15:00Z"),
    ];
    orderByExpectedDeparture(rows);
    expect(rows.map((r) => r.tripId)).toEqual(["late", "ontime"]);
  });

  it("handles rows with no tripId", () => {
    const rows: OrderableDeparture[] = [
      { scheduled: "2026-07-15T06:15:00Z", status: "on-time" },
      { scheduled: "2026-07-15T06:00:00Z", status: "on-time" },
    ];
    const ordered = orderByExpectedDeparture(rows);
    expect(ordered.map((o) => o.departure.scheduled)).toEqual([
      "2026-07-15T06:00:00Z",
      "2026-07-15T06:15:00Z",
    ]);
  });

  it("handles an empty board", () => {
    expect(orderByExpectedDeparture([])).toEqual([]);
  });
});
