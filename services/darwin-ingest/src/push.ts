import apn from "@parse/node-apn";
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
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@signaller.local";
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

// ---------------------------------------------------------------------------
// APNs — native iOS app (apps/ios)
//
// Same contract as Web Push above: unconfigured is a no-op, not an error, so
// the alert pipeline keeps working (DB + Redis + Web Push) on a deployment
// that has no APNs credentials.
// ---------------------------------------------------------------------------

/** Tokens APNs has told us are dead. The caller deletes these rows. */
export interface ApnsResult {
  sent: number;
  /** Tokens that came back BadDeviceToken / Unregistered — stop using them. */
  deadTokens: string[];
}

let apnsProviders: { sandbox?: apn.Provider; production?: apn.Provider } | null = null;

/**
 * Token-based APNs auth: a `.p8` key, its id, and the team id. Preferred over
 * certificates because the key doesn't expire, so there's no annual rotation
 * to forget.
 *
 * Sandbox and production are separate hosts and a token is only valid against
 * the one it was issued for, so we keep a provider for each and route per row.
 */
function apnsProvider(environment: string): apn.Provider | null {
  const key = process.env.APNS_KEY_P8;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  if (!key || !keyId || !teamId) return null;

  apnsProviders ??= {};
  const wantSandbox = environment === "sandbox";
  const slot = wantSandbox ? "sandbox" : "production";
  if (apnsProviders[slot]) return apnsProviders[slot]!;

  try {
    apnsProviders[slot] = new apn.Provider({
      // The key arrives as an env var, so literal "\n" needs unescaping —
      // most secret stores can't hold a real newline.
      token: { key: key.replace(/\\n/g, "\n"), keyId, teamId },
      production: !wantSandbox,
    });
    return apnsProviders[slot]!;
  } catch (err) {
    console.error("[push] APNs setup failed:", (err as Error).message);
    return null;
  }
}

export function apnsConfigured(): boolean {
  return Boolean(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);
}

/**
 * Sends one alert to a user's iOS devices.
 *
 * Returns the tokens APNs rejected as permanently invalid so the caller can
 * delete those rows — the direct equivalent of the 404/410 handling that
 * clears a dead Web Push subscription.
 */
export async function sendAPNs(
  devices: { token: string; environment: string }[],
  payload: PushPayload,
): Promise<ApnsResult> {
  const topic = process.env.APNS_TOPIC ?? "uk.signaller.app";
  const result: ApnsResult = { sent: 0, deadTokens: [] };
  if (devices.length === 0 || !apnsConfigured()) return result;

  // Group by environment: each host needs its own provider and its own send.
  const byEnvironment = new Map<string, string[]>();
  for (const device of devices) {
    const key = device.environment === "sandbox" ? "sandbox" : "production";
    byEnvironment.set(key, [...(byEnvironment.get(key) ?? []), device.token]);
  }

  for (const [environment, tokens] of byEnvironment) {
    const provider = apnsProvider(environment);
    if (!provider) continue;

    const note = new apn.Notification();
    note.topic = topic;
    note.alert = { title: payload.title, body: payload.body };
    note.sound = "default";
    // Collapse repeated alerts about the same commute+day into one banner,
    // matching the Web Push `tag`.
    if (payload.tag) note.collapseId = payload.tag.slice(0, 64);
    // Where the notification tap should land, read by the app's deep-link
    // handler. `signaller://` is a registered URL scheme.
    note.payload = { url: payload.url };
    // Disruption alerts are worth waking the screen for.
    note.priority = 10;

    try {
      const response = await provider.send(note, tokens);
      result.sent += response.sent.length;
      for (const failure of response.failed) {
        const reason = failure.response?.reason ?? failure.error?.message ?? "unknown";
        if (reason === "BadDeviceToken" || reason === "Unregistered") {
          result.deadTokens.push(failure.device);
        } else {
          console.error(`[push] APNs failure (${reason}) for ${failure.device.slice(0, 8)}…`);
        }
      }
    } catch (err) {
      console.error("[push] APNs send failed:", (err as Error).message);
    }
  }

  return result;
}
