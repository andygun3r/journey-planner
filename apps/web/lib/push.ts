import { deviceToken, user } from "@signaller/db";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { getDb } from "./db";

/** VAPID public key the client needs to subscribe. Exposed to the browser. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/**
 * Whether this server can actually send a push. The public key alone is enough
 * for a browser to subscribe, but sending also needs the private key — so a
 * half-configured server can collect subscriptions it can never deliver to.
 * The admin test-alert page reports on this directly.
 */
export function pushSendConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let vapidReady = false;

/**
 * Send one push to a stored subscription, from the web app.
 *
 * services/darwin-ingest has its own copy of this (src/push.ts) — that's the
 * one every real alert goes through. This exists so the admin test alert can
 * verify VAPID/subscription setup from the web container itself, which is
 * where the misconfiguration usually is. Kept small and dependency-light
 * rather than shared via packages/shared, which apps/web also imports into
 * client components and so must stay free of Node-only packages like web-push.
 *
 * Returns the failing HTTP status, or null on success / when unconfigured.
 */
export async function sendPushFromWeb(
  subscription: unknown,
  payload: { title: string; body: string; url: string; tag?: string },
): Promise<number | null> {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  if (!vapidReady) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:alerts@signaller.local", pub, priv);
    vapidReady = true;
  }
  try {
    await webpush.sendNotification(
      subscription as webpush.PushSubscription,
      JSON.stringify(payload),
    );
    return null;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? null;
  }
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

/** A user's stored Web Push subscription, or null if they have none. */
export async function getPushSubscription(userId: string): Promise<unknown | null> {
  const rows = await getDb()
    .select({ sub: user.pushSubscription })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.sub ?? null;
}

// ---------------------------------------------------------------------------
// APNs device tokens (native iOS app)
//
// Separate from the Web Push subscription above: a user has one browser
// subscription but can have the app on several devices, so these are rows not
// a column. The sender lives in services/darwin-ingest/src/push.ts alongside
// sendPush — this half is only registration.
// ---------------------------------------------------------------------------

/**
 * Register (or move) an APNs token.
 *
 * Conflicts on the token, not the user: the same device signing into a
 * different account must move to that account rather than leave a stale row
 * delivering someone else's commute alerts.
 */
export async function saveDeviceToken(
  userId: string,
  token: string,
  environment: "sandbox" | "production",
  platform = "ios",
): Promise<void> {
  await getDb()
    .insert(deviceToken)
    .values({ userId, token, environment, platform })
    .onConflictDoUpdate({
      target: deviceToken.token,
      set: { userId, environment, platform, updatedAt: new Date() },
    });
}

/** Drop one device's token — sign-out, or APNs telling us it's dead. */
export async function clearDeviceToken(token: string): Promise<void> {
  await getDb().delete(deviceToken).where(eq(deviceToken.token, token));
}

/** Every device this user should be notified on. */
export async function listDeviceTokens(
  userId: string,
): Promise<{ token: string; environment: string }[]> {
  return getDb()
    .select({ token: deviceToken.token, environment: deviceToken.environment })
    .from(deviceToken)
    .where(eq(deviceToken.userId, userId));
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
