import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CommuteEditor } from "@/components/commute-editor";
import { getCommute } from "@/lib/commutes";
import { getUserId } from "@/lib/current-user";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export default async function EditCommutePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const [stations, commute] = await Promise.all([getStations(), getCommute(userId, id)]);
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
