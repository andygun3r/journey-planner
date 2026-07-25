import { TrainMap } from "@/components/train-map";
import { getStationCoords } from "@/lib/stations";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live map · Mainline",
  description: "Every tracked GB train, live from Network Rail.",
};

export default async function MapPage() {
  const stations = await getStationCoords().catch(() => []);

  return (
    <main className="map-main">
      <div className="results-head">
        <h1>
          Live map
          <span className="board-crs">Great Britain</span>
        </h1>
        <span className="when">Network Rail live positions</span>
      </div>
      <TrainMap stations={stations} />
    </main>
  );
}
