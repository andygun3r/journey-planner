"use client";

import { useEffect } from "react";

/**
 * Registers the service worker app-wide (previously only registered on push
 * opt-in, so most users never got one). Enables the offline app-shell cache in
 * sw.js and makes push registration instant when the user later opts in.
 */
export function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Register after load so it never competes with first paint.
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
