"use client";

import { useEffect, useState } from "react";

/** base64url VAPID key -> ArrayBuffer for PushManager.subscribe. */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

type State = "unsupported" | "unconfigured" | "default" | "granted" | "denied" | "busy";

interface PushPreferences {
  commuteDisruptions: boolean;
  preDeparture: boolean;
  networkDisruptions: boolean;
}

interface Props {
  vapidPublicKey: string | null;
  initiallySubscribed: boolean;
  initialPreferences: PushPreferences;
}

export function PushToggle({ vapidPublicKey, initiallySubscribed, initialPreferences }: Props) {
  const [state, setState] = useState<State>("default");
  const [subscribed, setSubscribed] = useState(initiallySubscribed);
  const [prefs, setPrefs] = useState(initialPreferences);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vapidPublicKey) {
      setState("unconfigured");
      return;
    }
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }
    setState(Notification.permission as State);
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setState("busy");
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission as State);
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
      });
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "You're signed out — sign in again and retry."
            : `Couldn't save the subscription (HTTP ${res.status}).`,
        );
      }
      setSubscribed(true);
      setState("granted");
    } catch (err) {
      // This used to swallow every failure and silently reset the button, so a
      // failed subscribe looked exactly like never having pressed it — while
      // the category checkboxes below still saved happily, making it look
      // opted-in with nothing actually subscribed.
      setError(err instanceof Error ? err.message : "Couldn't turn on push alerts.");
      setState("granted");
      setSubscribed(false);
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
      await fetch("/api/push", { method: "DELETE" });
      setSubscribed(false);
    } finally {
      setState("granted");
    }
  }

  async function setPreference(patch: Partial<PushPreferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic — matches accessibility-settings' save-on-change immediacy
    try {
      await fetch("/api/push/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      setPrefs(prefs); // revert on failure
    }
  }

  if (state === "unsupported") {
    return <p className="push-note">Push notifications aren&rsquo;t supported in this browser.</p>;
  }
  if (state === "unconfigured") {
    return null; // VAPID keys not set — hide the control entirely.
  }
  if (state === "denied") {
    return (
      <p className="push-note">
        Notifications are blocked. Enable them in your browser settings to get commute alerts.
      </p>
    );
  }

  return (
    <div className="push-toggle">
      {subscribed ? (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={disable}
            disabled={state === "busy"}
          >
            {state === "busy" ? "…" : "Turn off push alerts"}
          </button>
          <fieldset className="push-categories">
            <legend>What should push us alerts?</legend>
            <label className="day-toggle">
              <input
                type="checkbox"
                checked={prefs.commuteDisruptions}
                onChange={(e) => void setPreference({ commuteDisruptions: e.target.checked })}
              />
              Disruptions on my commute — cancellations and delays on my usual trains
            </label>
            <label className="day-toggle">
              <input
                type="checkbox"
                checked={prefs.preDeparture}
                onChange={(e) => void setPreference({ preDeparture: e.target.checked })}
              />
              Before I leave — how my train is looking, even when it&rsquo;s fine
            </label>
            <label className="day-toggle">
              <input
                type="checkbox"
                checked={prefs.networkDisruptions}
                onChange={(e) => void setPreference({ networkDisruptions: e.target.checked })}
              />
              Wider network disruptions that affect my commute
            </label>
          </fieldset>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={enable}
          disabled={state === "busy"}
        >
          {state === "busy" ? "…" : "Get push alerts"}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
