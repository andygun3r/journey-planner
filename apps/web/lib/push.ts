import { user } from "@signaller/db";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

/** VAPID public key the client needs to subscribe. Exposed to the browser. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** Store (or replace) a user's Web Push subscription. */
export async function savePushSubscription(
  userId: string,
  subscription: unknown,
): Promise<void> {
  await getDb().update(user).set({ pushSubscription: subscription }).where(eq(user.id, userId));
}

/** Remove a user's Web Push subscription. */
export async function clearPushSubscription(userId: string): Promise<void> {
  await getDb().update(user).set({ pushSubscription: null }).where(eq(user.id, userId));
}

/** Whether a user currently has a push subscription stored. */
export async function hasPushSubscription(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ sub: user.pushSubscription })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.sub != null;
}

/** Per-category push opt-in — which kinds of alert actually buzz the user's device. */
export interface PushPreferences {
  commuteDisruptions: boolean;
  preDeparture: boolean;
  networkDisruptions: boolean;
}

/** A user's current per-category push preferences (all false if unset/unknown). */
export async function getPushPreferences(userId: string): Promise<PushPreferences> {
  const rows = await getDb()
    .select({
      commuteDisruptions: user.pushCommuteDisruptions,
      preDeparture: user.pushPreDeparture,
      networkDisruptions: user.pushNetworkDisruptions,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0] ?? { commuteDisruptions: false, preDeparture: false, networkDisruptions: false };
}

/** Update one or more of a user's push category preferences. */
export async function setPushPreferences(
  userId: string,
  patch: Partial<PushPreferences>,
): Promise<void> {
  const set: Record<string, boolean> = {};
  if (patch.commuteDisruptions !== undefined) set.pushCommuteDisruptions = patch.commuteDisruptions;
  if (patch.preDeparture !== undefined) set.pushPreDeparture = patch.preDeparture;
  if (patch.networkDisruptions !== undefined) set.pushNetworkDisruptions = patch.networkDisruptions;
  if (Object.keys(set).length === 0) return;
  await getDb().update(user).set(set).where(eq(user.id, userId));
}
