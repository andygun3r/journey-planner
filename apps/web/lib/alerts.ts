import { alert, commute } from "@mainline/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./db";

export interface AlertRecord {
  id: string;
  commuteId: string;
  kind: string;
  headline: string;
  detail: string | null;
  direction: string | null;
  createdAt: string;
  seenAt: string | null;
}

/** A device's alerts, newest first, joined through commute ownership. */
export async function listAlerts(
  userId: string,
  opts: { unseenOnly?: boolean; limit?: number } = {},
): Promise<AlertRecord[]> {
  const db = getDb();
  const conds = [eq(commute.userId, userId)];
  if (opts.unseenOnly) conds.push(isNull(alert.seenAt));

  const rows = await db
    .select({
      id: alert.id,
      commuteId: alert.commuteId,
      kind: alert.kind,
      headline: alert.headline,
      detail: alert.detail,
      direction: alert.direction,
      createdAt: alert.createdAt,
      seenAt: alert.seenAt,
    })
    .from(alert)
    .innerJoin(commute, eq(commute.id, alert.commuteId))
    .where(and(...conds))
    .orderBy(desc(alert.createdAt))
    .limit(opts.limit ?? 50);

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    seenAt: r.seenAt ? r.seenAt.toISOString() : null,
  }));
}

/** Mark one alert (or all of a device's alerts) seen. Ownership-checked. */
export async function markSeen(userId: string, alertId?: string): Promise<void> {
  const db = getDb();
  // Restrict to the device's own commutes' alerts.
  const owned = await db
    .select({ id: alert.id })
    .from(alert)
    .innerJoin(commute, eq(commute.id, alert.commuteId))
    .where(
      and(eq(commute.userId, userId), alertId ? eq(alert.id, alertId) : isNull(alert.seenAt)),
    );
  const ids = owned.map((o) => o.id);
  if (ids.length === 0) return;

  // One statement, not one per alert. "Mark all as seen" on a busy commute
  // used to fire a separate round trip for every unseen alert.
  await db.update(alert).set({ seenAt: new Date() }).where(inArray(alert.id, ids));
}
