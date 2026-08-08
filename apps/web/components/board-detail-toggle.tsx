"use client";

import { useState } from "react";
import { BoardTrainDetail } from "@/components/board-train-detail";

/**
 * The "Where is it?" control on a board row, and the panel it opens.
 *
 * A separate button rather than making the whole row expand: the row is already
 * a stretched link to the full service page, and hijacking that click would
 * take away the navigation people use most. This adds a second, explicit
 * affordance instead.
 *
 * State lives here so the board itself stays a server component — the row data
 * is server-rendered and refreshed on an interval, and only this small piece is
 * interactive.
 */
export function BoardDetailToggle({
  serviceId,
  destination,
}: {
  serviceId: string;
  /** Named in the button's accessible label so screen-reader users can tell
   *  twenty otherwise-identical "Where is it?" buttons apart. */
  destination: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="board-detail-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide detail" : "Where is it?"}
        <span className="sr-only"> for the service to {destination}</span>
      </button>
      {open && <BoardTrainDetail serviceId={serviceId} />}
    </>
  );
}
