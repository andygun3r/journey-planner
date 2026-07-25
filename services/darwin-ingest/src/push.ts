import webpush from "web-push";

/**
 * Web Push sender. VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 * / VAPID_SUBJECT). If they're not configured, push is a no-op so the rest of
 * the alert pipeline (DB + Redis) still works.
 */

let configured = false;
try {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@mainline.local";
  if (pub && priv) {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } else {
    console.warn("[push] VAPID keys not set — Web Push disabled");
  }
} catch (err) {
  console.error("[push] VAPID setup failed:", (err as Error).message);
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/**
 * Sends a push notification. Silently drops if VAPID isn't configured. On a
 * 404/410 (subscription gone) the caller's subscription should be cleared —
 * returns the failing status code so callers can react; returns null on success
 * or when push is disabled.
 */
export async function sendPush(
  subscription: unknown,
  payload: PushPayload,
): Promise<number | null> {
  if (!configured) return null;
  try {
    await webpush.sendNotification(
      subscription as webpush.PushSubscription,
      JSON.stringify(payload),
    );
    return null;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      // Subscription expired/unsubscribed — the device row's subscription should
      // be cleared by the caller.
      return status;
    }
    console.error("[push] send failed:", (err as Error).message);
    return status ?? null;
  }
}
