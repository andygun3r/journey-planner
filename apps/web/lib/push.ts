import { device } from "@mainline/db";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

/** VAPID public key the client needs to subscribe. Exposed to the browser. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** Store (or replace) a device's Web Push subscription. */
export async function savePushSubscription(
  deviceId: string,
  subscription: unknown,
): Promise<void> {
  await getDb()
    .update(device)
    .set({ pushSubscription: subscription })
    .where(eq(device.id, deviceId));
}

/** Remove a device's Web Push subscription. */
export async function clearPushSubscription(deviceId: string): Promise<void> {
  await getDb().update(device).set({ pushSubscription: null }).where(eq(device.id, deviceId));
}

/** Whether a device currently has a push subscription stored. */
export async function hasPushSubscription(deviceId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ sub: device.pushSubscription })
    .from(device)
    .where(eq(device.id, deviceId))
    .limit(1);
  return rows[0]?.sub != null;
}
