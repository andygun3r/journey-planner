"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StationInput, type StationOption } from "./station-input";

interface Props {
  crs: string;
  stations: StationOption[];
  /** Currently applied "calling at" filter, if any. */
  active?: { crs: string; name: string };
}

/** Filter a board to trains calling at a chosen station (LDBWS filterCrs). */
export function BoardFilter({ crs, stations, active }: Props) {
  const router = useRouter();
  const [station, setStation] = useState<StationOption | null>(
    active ? { crs: active.crs, name: active.name } : null,
  );

  function apply(next: StationOption | null) {
    setStation(next);
    if (next) router.push(`/boards/${crs}?callingAt=${next.crs}`);
    else router.push(`/boards/${crs}`);
  }

  return (
    <div className="board-filter">
      <StationInput
        label="Calling at"
        name="callingAt"
        stations={stations}
        value={station}
        onChange={apply}
        placeholder="Filter by a station on the route"
      />
      {active && (
        <button type="button" className="board-filter-clear" onClick={() => apply(null)}>
          Clear filter
        </button>
      )}
    </div>
  );
}
