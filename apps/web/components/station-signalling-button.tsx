"use client";

import Link from "next/link";
import { stationSignallingCorridor } from "@/lib/signalling-corridors";

/**
 * "View signalling diagram" for a station board. Only shown for stations on a
 * named corridor (SWML today) — links straight to that corridor's live board.
 */
export function StationSignallingButton({ crs }: { crs: string; name: string }) {
  const corridor = stationSignallingCorridor(crs);
  if (!corridor) return null;
  return (
    <div className="board-signal-actions">
      <Link href={`/signalling/${corridor.id}`} className="board-signal-btn board-signal-btn-primary">
        {corridor.shortTitle} live signalling
      </Link>
    </div>
  );
}
