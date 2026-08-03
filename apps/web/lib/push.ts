import { user } from "@mainline/db";
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
