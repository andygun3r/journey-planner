import Link from "next/link";
import { notFound } from "next/navigation";
import { CommuteEditor } from "@/components/commute-editor";
import { getCommute } from "@/lib/commutes";
import { requireDevice } from "@/lib/device";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function EditCommutePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const deviceId = await requireDevice();
  const [stations, commute] = await Promise.all([getStations(), getCommute(deviceId, id)]);
  if (!commute) notFound();

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>Edit commute</h1>
        <span className="when">
          <Link href="/commute">back to dashboard</Link>
        </span>
      </div>
      <CommuteEditor stations={stations} commute={commute} />
    </main>
  );
}
