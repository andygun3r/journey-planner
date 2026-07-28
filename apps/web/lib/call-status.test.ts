import { describe, expect, it } from "vitest";
import { callLiveStatus, deltaChip, type CallStatusInput } from "./call-status";

const call = (over: Partial<CallStatusInput> = {}): CallStatusInput => ({
  scheduled: "07:42",
  scheduledIso: "2026-07-15T06:42:00Z",
  ...over,
});

describe("callLiveStatus", () => {
  it("reports 'No report' when the feed says nothing", () => {
    // The regression this exists for: the service page printed a confident
    // "On time" for a train nothing was known about. The board client always
    // did the opposite ("not a confirmed on-time status, so don't claim one").
    expect(callLiveStatus(call({ expected: undefined }))).toMatchObject({
      kind: "no-report",
      label: "No report",
    });
    expect(callLiveStatus(call({ expected: "   " })).kind).toBe("no-report");
  });

  it("passes through an explicit On time", () => {
    expect(callLiveStatus(call({ expected: "On time" }))).toMatchObject({
      kind: "on-time",
      label: "On time",
    });
    expect(callLiveStatus(call({ expected: "ON TIME" })).kind).toBe("on-time");
  });

  it("treats a cancelled flag or a cancelled estimate the same", () => {
    expect(callLiveStatus(call({ cancelled: true })).kind).toBe("cancelled");
    // The string form used to fall through and render as a delay.
    expect(callLiveStatus(call({ expected: "Cancelled" })).kind).toBe("cancelled");
    expect(callLiveStatus(call({ expected: "cancelled" })).kind).toBe("cancelled");
  });

  it("quantifies a delay from the estimate", () => {
    const s = callLiveStatus(call({ expected: "07:46", expectedIso: "2026-07-15T06:46:00Z" }));
    expect(s).toMatchObject({ kind: "delayed", label: "Exp. 07:46", deltaMinutes: 4 });
    expect(deltaChip(s)).toBe("+4");
  });

  it("treats a one-minute variance as on time", () => {
    const s = callLiveStatus(call({ expected: "07:43", expectedIso: "2026-07-15T06:43:00Z" }));
    expect(s.kind).toBe("on-time");
    expect(deltaChip(s)).toBeUndefined();
  });

  it("marks genuinely early running as early, not delayed", () => {
    // `exp !== scheduled` string inequality used to call this a delay.
    const s = callLiveStatus(call({ expected: "07:38", expectedIso: "2026-07-15T06:38:00Z" }));
    expect(s.kind).toBe("early");
    expect(s.deltaMinutes).toBe(-4);
    expect(deltaChip(s)).toBe("−4");
  });

  it("prefers an actual report over an estimate", () => {
    const s = callLiveStatus(
      call({
        expected: "07:50",
        expectedIso: "2026-07-15T06:50:00Z",
        actual: "07:44",
        actualIso: "2026-07-15T06:44:00Z",
      }),
    );
    expect(s.label).toBe("07:44");
    expect(s.deltaMinutes).toBe(2);
  });

  it("keeps 'Delayed' with no estimate as an unquantified delay", () => {
    expect(callLiveStatus(call({ expected: "Delayed" }))).toMatchObject({
      kind: "delayed",
      label: "Delayed",
    });
  });

  it("renders unrecognised feed text neutrally, not as a delay", () => {
    // "Starts here", "No report", "Bus" all used to get delay styling from the
    // old catch-all branch.
    for (const text of ["Starts here", "No report", "Bus", "Ferry"]) {
      const s = callLiveStatus(call({ expected: text }));
      expect(s.kind).toBe("info");
      expect(s.label).toBe(text);
    }
  });

  it("falls back to wall-clock arithmetic when there are no instants", () => {
    const s = callLiveStatus({ scheduled: "07:42", expected: "07:46" });
    expect(s).toMatchObject({ kind: "delayed", deltaMinutes: 4 });
  });

  it("does not read a delay across midnight as a 23-hour early arrival", () => {
    const s = callLiveStatus({ scheduled: "23:58", expected: "00:06" });
    expect(s.deltaMinutes).toBe(8);
    expect(s.kind).toBe("delayed");
  });

  it("survives a scheduled time it cannot parse", () => {
    const s = callLiveStatus({ scheduled: undefined, expected: "07:46" });
    expect(s.kind).toBe("info");
    expect(s.label).toBe("07:46");
  });

  it("cancellation outranks everything else", () => {
    const s = callLiveStatus(call({ cancelled: true, actual: "07:44", expected: "07:46" }));
    expect(s.kind).toBe("cancelled");
  });
});

describe("deltaChip", () => {
  it("is undefined inside the on-time tolerance", () => {
    expect(deltaChip({ kind: "on-time", label: "On time", deltaMinutes: 0 })).toBeUndefined();
    expect(deltaChip({ kind: "on-time", label: "On time", deltaMinutes: 1 })).toBeUndefined();
    expect(deltaChip({ kind: "on-time", label: "On time" })).toBeUndefined();
  });

  it("signs the value both ways", () => {
    expect(deltaChip({ kind: "delayed", label: "x", deltaMinutes: 12 })).toBe("+12");
    expect(deltaChip({ kind: "early", label: "x", deltaMinutes: -3 })).toBe("−3");
  });
});
