"use client";

import { useEffect, useState } from "react";

/**
 * Ticking countdown to an ISO instant. Shows "due", "1 min", "6 mins", or
 * "20:41" when far off. Updates every 15s client-side without a page refresh.
 */
export function LiveCountdown({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return null;
  const mins = Math.round((target - now) / 60000);

  if (mins <= 0) return <span className="countdown countdown-due">due</span>;
  if (mins <= 59) {
    return (
      <span className="countdown">
        {mins} min{mins === 1 ? "" : "s"}
      </span>
    );
  }
  // Far away — show the clock time instead of a long countdown.
  const t = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  }).format(new Date(target));
  return <span className="countdown countdown-far">{t}</span>;
}
