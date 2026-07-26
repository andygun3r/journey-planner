import { BoardPicker } from "@/components/board-picker";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function BoardsIndex() {
  // Only need the count for the empty-state; the picker fetches via /api/stations.
  let stationCount = 0;
  let unavailable = false;
  try {
    stationCount = (await getStations()).length;
  } catch {
    unavailable = true;
  }

  return (
    <main>
      <h1 className="search-title">Live departures</h1>
      <p className="board-intro">
        Pick a station to see what’s leaving — like the boards on the platform.
      </p>
      <div className="search-panel">
        <BoardPicker />
      </div>
      {(unavailable || stationCount === 0) && (
        <div className="notice">
          <h2>Station data not loaded yet</h2>
          <p>Load the timetable into the database, then refresh.</p>
        </div>
      )}
    </main>
  );
}
