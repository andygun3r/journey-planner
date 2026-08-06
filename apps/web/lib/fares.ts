import {
  fare,
  fareFlow,
  ndfOverride,
  nrCorpus,
  station,
  stationCluster,
  ticketType,
} from "@signaller/db";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Indicative walk-up fares from the DTD RJFAF data (fare_flow → fare →
 * ticket_type). This is deliberately INDICATIVE: cheapest standard-class
 * single/return for the origin→destination flow, honouring fares published
 * against a station's fare cluster. No Routeing Guide validation, no railcards,
 * no restriction decoding — matches the v1 "indicative fares" scope.
 *
 * Returns null (UI shows no price) when fares aren't loaded or no flow exists —
 * so the whole feature is a graceful no-op until the RJFAF data is imported.
 */

export interface IndicativeFare {
  /** Cheapest standard single, in pence. */
  singlePence?: number;
  /** Cheapest standard return, in pence. */
  returnPence?: number;
}

/** NLC(s) a station's fares may be published under: its own NLC + any clusters. */
async function nlcsFor(crs: string): Promise<string[]> {
  const db = getDb();
  // Prefer station.nlc; fall back to the CORPUS reference (nr_corpus), which
  // carries NLC for every CRS even though the timetable loader leaves
  // station.nlc empty.
  const stRows = await db
    .select({ nlc: station.nlc })
    .from(station)
    .where(eq(station.crs, crs))
    .limit(1);
  let nlc = stRows[0]?.nlc ?? null;
  if (!nlc) {
    const corp = await db
      .select({ nlc: nrCorpus.nlc })
      .from(nrCorpus)
      .where(and(eq(nrCorpus.crs, crs), isNotNull(nrCorpus.nlc)))
      .limit(1);
    nlc = corp[0]?.nlc ?? null;
  }
  if (!nlc) return [];

  // Clusters this NLC belongs to (fares are often published at cluster level).
  const clusters = await db
    .select({ clusterNlc: stationCluster.clusterNlc })
    .from(stationCluster)
    .where(eq(stationCluster.memberNlc, nlc));

  return [nlc, ...clusters.map((c) => c.clusterNlc)];
}

export async function indicativeFare(
  fromCrs: string,
  toCrs: string,
): Promise<IndicativeFare | null> {
  const db = getDb();
  const [originNlcs, destNlcs] = await Promise.all([nlcsFor(fromCrs), nlcsFor(toCrs)]);
  if (originNlcs.length === 0 || destNlcs.length === 0) return null;

  // Flows in either direction (reversible flows are stored one way with direction=R).
  const flows = await db
    .select({
      flowId: fareFlow.flowId,
      originNlc: fareFlow.originNlc,
      destNlc: fareFlow.destNlc,
      routeCode: fareFlow.routeCode,
    })
    .from(fareFlow)
    .where(
      or(
        and(inArray(fareFlow.originNlc, originNlcs), inArray(fareFlow.destNlc, destNlcs)),
        and(inArray(fareFlow.originNlc, destNlcs), inArray(fareFlow.destNlc, originNlcs)),
      ),
    );
  if (flows.length === 0) return null;

  const flowIds = flows.map((f) => f.flowId);

  // Cheapest standard-class single/return across those flows.
  const priced = await db
    .select({
      pricePence: fare.pricePence,
      type: ticketType.type,
      cls: ticketType.class,
    })
    .from(fare)
    .innerJoin(ticketType, eq(ticketType.code, fare.ticketCode))
    .where(and(inArray(fare.flowId, flowIds), eq(ticketType.class, "2")));

  let singlePence: number | undefined;
  let returnPence: number | undefined;
  for (const p of priced) {
    if (p.type === "S") singlePence = Math.min(singlePence ?? Infinity, p.pricePence);
    else if (p.type === "R") returnPence = Math.min(returnPence ?? Infinity, p.pricePence);
  }

  // NDF overrides are authoritative corrections for flows the standard fare
  // tables can't price correctly — where one matches, it replaces the
  // computed price rather than just floors it.
  const overrideConds = flows.flatMap((f) =>
    ["S", "R"].map((ticketCode) =>
      and(
        eq(ndfOverride.originNlc, f.originNlc),
        eq(ndfOverride.destNlc, f.destNlc),
        eq(ndfOverride.routeCode, f.routeCode),
        eq(ndfOverride.railcard, ""),
        eq(ndfOverride.ticketCode, ticketCode),
      ),
    ),
  );
  const overrides =
    overrideConds.length > 0
      ? await db
          .select({ ticketCode: ndfOverride.ticketCode, pricePence: ndfOverride.pricePence })
          .from(ndfOverride)
          .where(or(...overrideConds))
      : [];
  for (const o of overrides) {
    if (o.ticketCode === "S") singlePence = Math.min(singlePence ?? Infinity, o.pricePence);
    else if (o.ticketCode === "R") returnPence = Math.min(returnPence ?? Infinity, o.pricePence);
  }

  if (singlePence === undefined && returnPence === undefined) return null;
  return { singlePence, returnPence };
}

/** Format pence as "£X.XX". */
export function formatFare(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}
