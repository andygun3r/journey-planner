import { createDb, nrRtppm, nrTsr, nrVstpSchedule } from "@mainline/db";
import { eq } from "drizzle-orm";
import type { RtppmRow, Tsr, VstpSchedule } from "./parse-feeds.js";

const db = createDb();

export async function applyVstp(s: VstpSchedule): Promise<void> {
  // A Delete transaction withdraws the schedule entirely.
  if (s.transactionType?.toLowerCase() === "delete") {
    await db.delete(nrVstpSchedule).where(eq(nrVstpSchedule.id, s.id));
    return;
  }
  const values = {
    id: s.id,
    trainUid: s.trainUid,
    startDate: s.startDate ?? null,
    endDate: s.endDate ?? null,
    stpIndicator: s.stpIndicator ?? null,
    transactionType: s.transactionType ?? null,
    headcode: s.headcode ?? null,
    originTiploc: s.originTiploc ?? null,
    destTiploc: s.destTiploc ?? null,
    schedule: s.schedule,
    receivedAt: new Date(),
  };
  await db
    .insert(nrVstpSchedule)
    .values(values)
    .onConflictDoUpdate({ target: nrVstpSchedule.id, set: values });
}

export async function applyTsr(t: Tsr): Promise<void> {
  const values = {
    tsrId: t.tsrId,
    routeGroup: t.routeGroup ?? null,
    routeCode: t.routeCode ?? null,
    fromStanox: t.fromStanox ?? null,
    toStanox: t.toStanox ?? null,
    lineName: t.lineName ?? null,
    direction: t.direction ?? null,
    passengerSpeedMph: t.passengerSpeedMph ?? null,
    freightSpeedMph: t.freightSpeedMph ?? null,
    validFrom: t.validFrom ?? null,
    validTo: t.validTo ?? null,
    reason: t.reason ?? null,
    raw: t.raw,
    updatedAt: new Date(),
  };
  await db
    .insert(nrTsr)
    .values(values)
    .onConflictDoUpdate({ target: nrTsr.tsrId, set: values });
}

export async function applyRtppm(r: RtppmRow): Promise<void> {
  const values = {
    operatorCode: r.operatorCode,
    operatorName: r.operatorName ?? null,
    total: r.total ?? null,
    onTime: r.onTime ?? null,
    late: r.late ?? null,
    cancelVeryLate: r.cancelVeryLate ?? null,
    ppm: r.ppm ?? null,
    rollingPpm: r.rollingPpm ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(nrRtppm)
    .values(values)
    .onConflictDoUpdate({ target: nrRtppm.operatorCode, set: values });
}
