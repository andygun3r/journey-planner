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

interface Props {
  vapidPublicKey: string | null;
  initiallySubscribed: boolean;
}

export function PushToggle({ vapidPublicKey, initiallySubscribed }: Props) {
  const [state, setState] = useState<State>("default");
  const [subscribed, setSubscribed] = useState(initiallySubscribed);

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
      if (!res.ok) throw new Error("save failed");
      setSubscribed(true);
      setState("granted");
    } catch {
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
        <button
          type="button"
          className="btn btn-secondary"
          onClick={disable}
          disabled={state === "busy"}
        >
          {state === "busy" ? "…" : "Turn off push alerts"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={enable}
          disabled={state === "busy"}
        >
          {state === "busy" ? "…" : "Get push alerts for disruptions"}
        </button>
      )}
    </div>
  );
}
