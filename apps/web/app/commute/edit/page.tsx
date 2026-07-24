import Link from "next/link";
import { CommuteEditor } from "@/components/commute-editor";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function NewCommutePage() {
  const stations = await getStations();
  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>New commute</h1>
        <span className="when">
          <Link href="/commute">back to dashboard</Link>
        </span>
      </div>
      <CommuteEditor stations={stations} commute={null} />
    </main>
  );
}
