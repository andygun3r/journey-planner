"use client";

import { useState } from "react";

/** Star toggle to save/unsave the current from→to journey for this device. */
export function FavouriteToggle({
  fromCrs,
  toCrs,
  initialSaved,
}: {
  fromCrs: string;
  toCrs: string;
  initialSaved: boolean;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !saved;
    setSaved(next); // optimistic
    try {
      await fetch("/api/favourites", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromCrs, to: toCrs }),
      });
    } catch {
      setSaved(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`fav-toggle ${saved ? "fav-saved" : ""}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved journeys" : "Save this journey"}
    >
      <span aria-hidden="true">{saved ? "★" : "☆"}</span>
      {saved ? "Saved" : "Save"}
    </button>
  );
}
