"use client";

import Link from "next/link";
import { useState } from "react";
import { stationSignallingCorridor } from "@/lib/signalling-corridors";
import { SignallingDiagram } from "./signalling-diagram";

/**
 * "View signalling diagram" for a station board. The diagram used to be opened
 * per-train, but a single service's corridor didn't tell you anything a
 * station-level view couldn't — this shows every TD area signalling the
 * station itself, live trains and all.
 */
export function StationSignallingButton({ crs, name }: { crs: string; name: string }) {
  const [open, setOpen] = useState(false);
  const corridor = stationSignallingCorridor(crs);
  return (
    <>
      <div className="board-signal-actions">
        {corridor && (
          <Link
            href={`/signalling/${corridor.id}`}
            className="board-signal-btn board-signal-btn-primary"
          >
            {corridor.shortTitle} live signalling
          </Link>
        )}
        <button type="button" className="board-signal-btn" onClick={() => setOpen(true)}>
          TD area diagram
        </button>
      </div>
      {open && (
        <SignallingDiagram
          query={`crs=${encodeURIComponent(crs)}`}
          title={name}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
