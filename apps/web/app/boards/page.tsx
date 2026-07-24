import { BoardPicker } from "@/components/board-picker";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function BoardsIndex() {
  let stations: Awaited<ReturnType<typeof getStations>> = [];
  let unavailable = false;
  try {
    stations = await getStations();
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
        <BoardPicker stations={stations} />
      </div>
      {(unavailable || stations.length === 0) && (
        <div className="notice">
          <h2>Station data not loaded yet</h2>
          <p>Load the timetable into the database, then refresh.</p>
        </div>
      )}
    </main>
  );
}
