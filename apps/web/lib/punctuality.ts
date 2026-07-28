import { nrRtppm, nrVstpSchedule } from "@mainline/db";
import { desc, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { londonDateKey } from "./uk-time";

/**
 * Network punctuality from the Network Rail Real Time PPM feed (nr_rtppm,
 * ingested by services/nr-ingest). PPM = "Public Performance Measure": the % of
 * trains arriving at their destination on time (within 5/10 min). Surfaced as a
 * "how's the railway doing" view and as per-operator chips on boards.
 */

export type PpmStatus = "good" | "marginal" | "poor" | "unknown";

/** Thresholds for the PPM headline status (never colour-alone — chip carries text). */
export function ppmStatus(ppm: number | null): PpmStatus {
  if (ppm == null) return "unknown";
  if (ppm >= 90) return "good";
  if (ppm >= 80) return "marginal";
  return "poor";
}

export interface OperatorPunctuality {
  code: string;
  name: string;
  total: number;
  onTime: number;
  late: number;
  cancelVeryLate: number;
  ppm: number | null;
  rollingPpm: number | null;
  status: PpmStatus;
}

export interface NetworkPunctuality {
  national: OperatorPunctuality | null;
  operators: OperatorPunctuality[];
  updatedAt: string | null;
  /** Count of short-notice (VSTP) schedules active today, if any. */
  vstpToday: number;
}

function toRow(r: typeof nrRtppm.$inferSelect): OperatorPunctuality {
  return {
    code: r.operatorCode,
    name: r.operatorName ?? r.operatorCode,
    total: r.total ?? 0,
    onTime: r.onTime ?? 0,
    late: r.late ?? 0,
    cancelVeryLate: r.cancelVeryLate ?? 0,
    ppm: r.ppm,
    rollingPpm: r.rollingPpm,
    status: ppmStatus(r.ppm),
  };
}

export async function getNetworkPunctuality(): Promise<NetworkPunctuality> {
  const db = getDb();
  const rows = await db.select().from(nrRtppm);

  let national: OperatorPunctuality | null = null;
  const operators: OperatorPunctuality[] = [];
  let updatedAt: Date | null = null;

  for (const r of rows) {
    if (r.updatedAt && (!updatedAt || r.updatedAt > updatedAt)) updatedAt = r.updatedAt;
    const row = toRow(r);
    if (r.operatorCode === "NATIONAL") national = row;
    else if (row.total > 0) operators.push(row); // hide operators with no trains today
  }

  // Worst-performing first — that's the operationally interesting end.
  operators.sort((a, b) => (a.ppm ?? 101) - (b.ppm ?? 101));

  let vstpToday = 0;
  try {
    // The London service date, not the UTC one — during BST these differ
    // between 23:00 and midnight, which is exactly when a late-evening board
    // would drop the day's VSTP schedules a whole hour early.
    const today = londonDateKey();
    const vstp = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(nrVstpSchedule)
      .where(gte(nrVstpSchedule.endDate, today));
    vstpToday = vstp[0]?.n ?? 0;
  } catch {
    /* vstp is supplementary */
  }

  return {
    national,
    operators,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    vstpToday,
  };
}

/** Single operator's punctuality by TOC name (for board/commute chips). */
export async function operatorPunctualityByName(
  operatorName: string,
): Promise<OperatorPunctuality | null> {
  const rows = await getDb()
    .select()
    .from(nrRtppm)
    .where(sql`lower(${nrRtppm.operatorName}) = lower(${operatorName})`)
    .orderBy(desc(nrRtppm.updatedAt))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}
