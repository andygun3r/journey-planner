import { SearchForm } from "@/components/search-form";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function Home() {
  let stations: Awaited<ReturnType<typeof getStations>> = [];
  let stationsUnavailable = false;
  try {
    stations = await getStations();
  } catch {
    stationsUnavailable = true;
  }

  return (
    <main>
      <h1 className="search-title">Where to?</h1>
      <SearchForm stations={stations} />
      {(stationsUnavailable || stations.length === 0) && (
        <div className="notice">
          <h2>Station data not loaded yet</h2>
          <p>
            The timetable hasn&rsquo;t been imported into the database, so station search
            has nothing to suggest.
          </p>
          <p>
            Run <code>docker compose --profile etl run --rm etl postprocess</code> to load
            stations and trip mappings, then refresh.
          </p>
        </div>
      )}
    </main>
  );
}
