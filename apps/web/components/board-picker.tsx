"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StationInput, type StationOption } from "./station-input";

/** Standalone "check a station's departures" entry point. */
export function BoardPicker({ stations }: { stations: StationOption[] }) {
  const router = useRouter();
  const [station, setStation] = useState<StationOption | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (station) router.push(`/boards/${station.crs}`);
  }

  return (
    <form className="board-picker" onSubmit={submit}>
      <StationInput
        label="Live departures at"
        name="station"
        stations={stations}
        value={station}
        onChange={setStation}
        placeholder="Station name or code"
      />
      <button className="btn" type="submit" disabled={!station}>
        View board
      </button>
    </form>
  );
}
