"use client";

import { useState } from "react";
import { SignallingDiagram } from "./signalling-diagram";

/**
 * "View signalling diagram" for a station board. The diagram used to be opened
 * per-train, but a single service's corridor didn't tell you anything a
 * station-level view couldn't — this shows every TD area signalling the
 * station itself, live trains and all.
 */
export function StationSignallingButton({ crs, name }: { crs: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="board-signal-btn" onClick={() => setOpen(true)}>
        View signalling diagram →
      </button>
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
