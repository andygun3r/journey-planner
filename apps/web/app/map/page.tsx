import { LiveMap } from "@/components/live-map";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live map · Signaller",
  description: "Every tracked GB train, live from Network Rail.",
};

export default function MapPage() {
  return (
    <main className="map-main">
      <LiveMap />
    </main>
  );
}
