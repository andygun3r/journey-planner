import { alert, commute, commuteCorridor, darwinTrain, getSharedDb, user } from "@signaller/db";
import {
  fetchNetworkDisruptions,
  disruptionsConfigured,
  londonDateKey,
  tocCodeForName,
  type Disruption,
} from "@signaller/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import { isUserOnHoliday, publishAndPush } from "./alerts.js";

/**
 * Network-disruption alerting: poll the RDG Disruptions API and, for each
 * active disruption, push it to any user whose commute is actually served by
 * an affected operator — not a firehose of every disruption everywhere.
 *
 * "Relevant to the user" is decided by TOC overlap: which operators run the
 * trains in a commute's precomputed corridor (commute_corridor) for today.
 * The corridor's own `tocs` column is only populated for pinned legs (the
 * user picked a specific train off a live board, which carries its TOC) —
 * the live-search path has no operator info at precompute time, since
 * neither the routing engine's plan() output nor trip_mapping carries one.
 * So this resolves TOC here, at poll time, from darwin_train (same-day
 * Darwin schedule data — unlike at precompute time, which runs the night
 * before a corridor's service date and can be well ahead of when Darwin has
 * sent that day's schedules).
 */

const db = getSharedDb();

/** Today's train_uid -> toc for every corridor row missing one already. */
async function tocsByUid(uids: string[], serviceDate: string): Promise<Map<string, string>> {
  if (uids.length === 0) return new Map();
  const rows = await db
    .select({ uid: darwinTrain.uid, toc: darwinTrain.toc })
    .from(darwinTrain)
    .where(and(inArray(darwinTrain.uid, uids), eq(darwinTrain.ssd, serviceDate)));
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.toc) map.set(r.uid, r.toc);
  }
  return map;
}

interface CommuteMatch {
  commuteId: string;
  userId: string;
  commuteLabel: string;
  pushSubscription: unknown;
  pushNetworkDisruptions: boolean;
}

/** Commutes (with owning user) whose today corridor includes any of the given TOC codes. */
async function commutesForTocs(tocCodes: string[], serviceDate: string): Promise<CommuteMatch[]> {
  if (tocCodes.length === 0) return [];

  // Corridor rows for today, with their trainUid so we can resolve TOC where
  // the stored `tocs` column is empty (the live-search path, see module doc).
  const corridorRows = await db
    .select({
      commuteId: commuteCorridor.commuteId,
      trainUid: commuteCorridor.trainUid,
      tocs: commuteCorridor.tocs,
    })
    .from(commuteCorridor)
    .where(eq(commuteCorridor.serviceDate, serviceDate));
  if (corridorRows.length === 0) return [];

  const uidsNeedingLookup = corridorRows.filter((r) => r.tocs.length === 0).map((r) => r.trainUid);
  const resolvedTocs = await tocsByUid(uidsNeedingLookup, serviceDate);

  const wanted = new Set(tocCodes);
  const matchedCommuteIds = new Set<string>();
  for (const row of corridorRows) {
    const tocs = row.tocs.length > 0 ? row.tocs : resolvedTocs.has(row.trainUid) ? [resolvedTocs.get(row.trainUid)!] : [];
    if (tocs.some((t) => wanted.has(t))) matchedCommuteIds.add(row.commuteId);
  }
  if (matchedCommuteIds.size === 0) return [];

  return db
    .select({
      commuteId: commute.id,
      userId: commute.userId,
      commuteLabel: commute.label,
      pushSubscription: user.pushSubscription,
      pushNetworkDisruptions: user.pushNetworkDisruptions,
    })
    .from(commute)
    .innerJoin(user, eq(user.id, commute.userId))
    .where(inArray(commute.id, [...matchedCommuteIds]));
}

/** One poll tick: fetch active disruptions and alert affected commutes. */
export async function pollNetworkDisruptions(redis: Redis | null): Promise<void> {
  if (!disruptionsConfigured()) return;

  const disruptions = await fetchNetworkDisruptions();
  if (disruptions.length === 0) return;

  const today = londonDateKey();
  for (const disruption of disruptions) {
    await raiseForDisruption(disruption, today, redis);
  }
}

async function raiseForDisruption(disruption: Disruption, serviceDate: string, redis: Redis | null): Promise<void> {
  const tocCodes = disruption.operators
    .map((name) => tocCodeForName(name))
    .filter((c): c is string => Boolean(c));
  if (tocCodes.length === 0) return;

  const matches = await commutesForTocs(tocCodes, serviceDate);
  for (const match of matches) {
    if (await isUserOnHoliday(match.userId, serviceDate)) continue;

    const inserted = await db
      .insert(alert)
      .values({
        commuteId: match.commuteId,
        kind: "network_disruption",
        ref: disruption.id,
        serviceDate,
        headline: disruption.summary,
        detail: firstDetailLine(disruption),
      })
      .onConflictDoNothing({
        target: [alert.commuteId, alert.ref, alert.kind, alert.serviceDate],
      })
      .returning({ id: alert.id });

    if (inserted.length === 0) continue; // already raised today, dedupe hit

    await publishAndPush({
      alertId: inserted[0]!.id,
      commuteId: match.commuteId,
      userId: match.userId,
      commuteLabel: match.commuteLabel,
      kind: "network_disruption",
      headline: disruption.summary,
      detail: firstDetailLine(disruption),
      direction: null,
      serviceDate,
      pushSubscription: match.pushSubscription,
      category: "network",
      categoryEnabled: match.pushNetworkDisruptions,
      redis,
    });
  }
}

/** First readable line of a disruption's description, for the push body. */
function firstDetailLine(d: Disruption): string | undefined {
  for (const block of d.blocks) {
    const text = block.content
      .map((c) => c.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}
