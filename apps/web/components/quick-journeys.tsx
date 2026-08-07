"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FavouriteJourney } from "@/lib/favourites";
import { type RecentSearch, useRecents } from "./use-recents";

const GPS_TIMEOUT_MS = 8000;

function locate(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: GPS_TIMEOUT_MS },
    );
  });
}

/**
 * Home-screen shortcuts: saved journeys (server, device-keyed) and recent
 * searches (localStorage). Each is a one-tap chip that re-runs the journey —
 * the "five-second, one-hand" path for a returning commuter.
 */
export function QuickJourneys({ initialFavourites }: { initialFavourites: FavouriteJourney[] }) {
  const router = useRouter();
  const { recents, remove } = useRecents();
  const [favourites, setFavourites] = useState<FavouriteJourney[]>(initialFavourites);
  const [locating, setLocating] = useState<string | null>(null); // keyed by recent's `to`, while a GPS fix is pending

  async function runGpsRecent(r: RecentSearch) {
    setLocating(r.to);
    const fix = await locate();
    setLocating(null);
    if (!fix) return; // silent — the search form itself is the place to explain a denial
    router.push(`/journeys?from=geo:${fix.lat},${fix.lon}&to=${encodeURIComponent(r.to)}`);
  }

  // Refresh favourites on mount in case they changed elsewhere.
  useEffect(() => {
    let alive = true;
    fetch("/api/favourites")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.favourites) setFavourites(d.favourites as FavouriteJourney[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function unsave(fav: FavouriteJourney) {
    setFavourites((prev) => prev.filter((f) => f.id !== fav.id));
    await fetch("/api/favourites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: fav.fromCrs, to: fav.toCrs }),
    }).catch(() => {});
  }

  // Hide recents that duplicate a saved journey.
  const savedPairs = new Set(favourites.map((f) => `${f.fromCrs}>${f.toCrs}`));
  const shownRecents = recents.filter((r) => !savedPairs.has(`${r.from}>${r.to}`));

  if (favourites.length === 0 && shownRecents.length === 0) return null;

  return (
    <div className="quick-journeys">
      {favourites.length > 0 && (
        <section className="quick-section" aria-label="Saved journeys">
          <h2 className="quick-head">Saved</h2>
          <ul className="quick-list">
            {favourites.map((f) => (
              <li key={f.id} className="quick-chip">
                <Link href={`/journeys?from=${f.fromCrs}&to=${f.toCrs}`} className="quick-chip-link">
                  <span aria-hidden="true" className="quick-star">
                    ★
                  </span>
                  {f.fromName} <span className="quick-arrow">→</span> {f.toName}
                </Link>
                <button
                  type="button"
                  className="quick-remove"
                  onClick={() => unsave(f)}
                  aria-label={`Remove saved journey ${f.fromName} to ${f.toName}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {shownRecents.length > 0 && (
        <section className="quick-section" aria-label="Recent searches">
          <h2 className="quick-head">Recent</h2>
          <ul className="quick-list">
            {shownRecents.map((r: RecentSearch) => (
              <li key={`${r.from}>${r.to}`} className="quick-chip">
                {r.from.startsWith("geo:") ? (
                  // Coordinates go stale — re-request a fresh fix rather than replaying the old one.
                  <button
                    type="button"
                    className="quick-chip-link quick-chip-gps"
                    onClick={() => void runGpsRecent(r)}
                    disabled={locating === r.to}
                  >
                    {locating === r.to ? "Finding your location…" : r.fromName}{" "}
                    <span className="quick-arrow">→</span> {r.toName}
                  </button>
                ) : (
                  <Link
                    href={`/journeys?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`}
                    className="quick-chip-link"
                  >
                    {r.fromName} <span className="quick-arrow">→</span> {r.toName}
                  </Link>
                )}
                <button
                  type="button"
                  className="quick-remove"
                  onClick={() => remove(r.from, r.to)}
                  aria-label={`Remove recent search ${r.fromName} to ${r.toName}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
