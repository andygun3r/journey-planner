import { QuickJourneys } from "@/components/quick-journeys";
import { SearchForm } from "@/components/search-form";
import { requireDevice } from "@/lib/device";
import { listFavourites } from "@/lib/favourites";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Stations power the empty-state check only; the typeahead fetches from
  // /api/stations on demand, so we don't embed the full list in the client.
  let stationCount = 0;
  let stationsUnavailable = false;
  try {
    stationCount = (await getStations()).length;
  } catch {
    stationsUnavailable = true;
  }

  const deviceId = await requireDevice();
  const favourites = await listFavourites(deviceId).catch(() => []);

  return (
    <main>
      <h1 className="search-title">Where to?</h1>
      <SearchForm />
      <QuickJourneys initialFavourites={favourites} />
      {(stationsUnavailable || stationCount === 0) && (
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
