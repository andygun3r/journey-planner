import { MapShell } from "@/components/map-shell";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Map · Signaller",
  description: "Plan a journey on the live map — every tracked GB train, and your route drawn end to end.",
};

export default async function MapPage() {
  // Embedded so the origin typeahead works instantly and offline-ish; the
  // destination box still queries /api/stations for places. If the station
  // table is unreachable the box falls back to fetching per keystroke, so an
  // empty list here degrades rather than breaks.
  const stations = await getStations().catch(() => []);

  return (
    <main className="map-main">
      <MapShell stations={stations.map((s) => ({ crs: s.crs, name: s.name }))} />
    </main>
  );
}
