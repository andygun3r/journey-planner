"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * The draggable panel that sits over the map. Three rest positions:
 *
 *   peek — just the search bar, map almost fully visible
 *   half — search plus results, the working default
 *   full — results and detail, for reading a journey through
 *
 * Draggable by pointer, but never *only* by pointer: the grab handle is a real
 * button that cycles positions on click/Enter, and the sheet responds to arrow
 * keys when focused. A drag-only sheet is unusable by keyboard and awkward
 * one-handed, which is the opposite of what this app is for.
 */

export type SheetPosition = "peek" | "half" | "full";

/** Fraction of the container height the sheet occupies at each rest position. */
const HEIGHTS: Record<SheetPosition, number> = {
  peek: 0.18,
  half: 0.5,
  full: 0.9,
};

const ORDER: SheetPosition[] = ["peek", "half", "full"];

/** Snap to whichever rest position the drag ended nearest. */
export function nearestPosition(fraction: number): SheetPosition {
  let best: SheetPosition = "half";
  let bestDistance = Infinity;
  for (const position of ORDER) {
    const distance = Math.abs(HEIGHTS[position] - fraction);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = position;
    }
  }
  return best;
}

/** Next/previous rest position, clamped at the ends. */
export function stepPosition(from: SheetPosition, direction: 1 | -1): SheetPosition {
  const next = ORDER.indexOf(from) + direction;
  return ORDER[Math.min(Math.max(next, 0), ORDER.length - 1)]!;
}

export function sheetHeightFraction(position: SheetPosition): number {
  return HEIGHTS[position];
}

interface Props {
  position: SheetPosition;
  onPositionChange: (position: SheetPosition) => void;
  /** Accessible name for the sheet region, e.g. "Journey planner". */
  label: string;
  children: React.ReactNode;
}

export function MapSheet({ position, onPositionChange, label, children }: Props) {
  const id = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  // Live height fraction while dragging; null when resting at `position`.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; containerHeight: number } | null>(null);

  const heightFraction = dragFraction ?? HEIGHTS[position];

  const endDrag = useCallback(
    (fraction: number) => {
      dragRef.current = null;
      setDragFraction(null);
      onPositionChange(nearestPosition(fraction));
    },
    [onPositionChange],
  );

  function onPointerDown(e: React.PointerEvent) {
    const container = rootRef.current?.parentElement;
    if (!container) return;
    // Ignore secondary buttons — a right-click shouldn't start a drag.
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, containerHeight: container.clientHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const container = rootRef.current?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Height is measured from the bottom of the container up to the pointer.
    const fraction = (rect.bottom - e.clientY) / drag.containerHeight;
    setDragFraction(Math.min(Math.max(fraction, 0.08), 0.95));
  }

  function onPointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    endDrag(dragFraction ?? HEIGHTS[position]);
  }

  function onHandleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onPositionChange(stepPosition(position, 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onPositionChange(stepPosition(position, -1));
    }
  }

  // A drag that ends outside the window still has to settle somewhere.
  useEffect(() => {
    function onCancel() {
      if (dragRef.current) endDrag(dragFraction ?? HEIGHTS[position]);
    }
    window.addEventListener("pointercancel", onCancel);
    return () => window.removeEventListener("pointercancel", onCancel);
  }, [dragFraction, position, endDrag]);

  return (
    <section
      ref={rootRef}
      className="map-sheet"
      aria-label={label}
      style={{
        height: `${heightFraction * 100}%`,
        // No transition mid-drag: the sheet must track the finger exactly.
        transition: dragFraction === null ? "height 220ms ease" : "none",
      }}
    >
      <button
        type="button"
        className="map-sheet-handle"
        aria-expanded={position === "full"}
        aria-controls={`${id}-body`}
        // Says what the control does, not what it looks like.
        aria-label={`${label}: drag, or press to ${position === "full" ? "collapse" : "expand"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onHandleKeyDown}
        onClick={() => {
          // Click cycles up and wraps at the top, so the sheet is fully
          // operable with a single repeated tap.
          onPositionChange(position === "full" ? "peek" : stepPosition(position, 1));
        }}
      >
        <span className="map-sheet-grip" aria-hidden="true" />
      </button>
      <div id={`${id}-body`} className="map-sheet-body">
        {children}
      </div>
    </section>
  );
}
