"use client";

import { useRouter, useSearchParams } from "next/navigation";

const OPTIONS = [-30, -15, 0, 15, 30, 45, 60];

function label(minutes: number): string {
  if (minutes === 0) return "On time";
  const abs = Math.abs(minutes);
  return minutes > 0 ? `+${abs}m late` : `−${abs}m early`;
}

/**
 * Quick same-day nudge: "running late" / "leaving early". Shifts the query
 * used for today's journey search only — never touches the saved weekly
 * schedule. Resets if the page is reloaded or the commute is switched.
 */
export function DailyFlex({ shiftMinutes }: { shiftMinutes: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setShift(minutes: number) {
    const params = new URLSearchParams(searchParams);
    if (minutes === 0) params.delete("shift");
    else params.set("shift", String(minutes));
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="daily-flex">
      <span className="daily-flex-label">Running late or leaving early today?</span>
      <div className="daily-flex-options" role="group" aria-label="Adjust today's departure time">
        {OPTIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={`chip chip-toggle ${minutes === shiftMinutes ? "chip-toggle-active" : ""}`}
            onClick={() => setShift(minutes)}
            aria-pressed={minutes === shiftMinutes}
          >
            {label(minutes)}
          </button>
        ))}
      </div>
    </div>
  );
}
