import { nrTsr } from "@signaller/db";
import { asc, gte, isNull, or } from "drizzle-orm";
import { getDb } from "./db";

export interface Tsr {
  tsrId: string;
  routeGroup: string | null;
  lineName: string | null;
  fromStanox: string | null;
  toStanox: string | null;
  passengerSpeedMph: number | null;
  reason: string | null;
  validFrom: string | null;
  validTo: string | null;
}

/** Currently active Temporary Speed Restrictions, from the NR VSTP/TSR feed. */
export async function activeTsrs(): Promise<Tsr[]> {
  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({
      tsrId: nrTsr.tsrId,
      routeGroup: nrTsr.routeGroup,
      lineName: nrTsr.lineName,
      fromStanox: nrTsr.fromStanox,
      toStanox: nrTsr.toStanox,
      passengerSpeedMph: nrTsr.passengerSpeedMph,
      reason: nrTsr.reason,
      validFrom: nrTsr.validFrom,
      validTo: nrTsr.validTo,
    })
    .from(nrTsr)
    .where(or(isNull(nrTsr.validTo), gte(nrTsr.validTo, now)))
    .orderBy(asc(nrTsr.routeGroup), asc(nrTsr.validFrom));

  return rows.map((r) => ({
    ...r,
    validFrom: r.validFrom ? r.validFrom.toISOString() : null,
    validTo: r.validTo ? r.validTo.toISOString() : null,
  }));
}
