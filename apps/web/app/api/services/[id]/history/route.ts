import { NextResponse } from "next/server";
import { fetchServiceDetails, serviceDetailsConfigured } from "@/lib/service-details";
import { getPositionHistory } from "@/lib/train-history";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!serviceDetailsConfigured()) {
    return NextResponse.json({ ok: false, reason: "not-configured" }, { status: 503 });
  }
  const details = await fetchServiceDetails(id);
  if (!details) {
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 404 });
  }
  if (!details.rid) {
    return NextResponse.json({ ok: false, reason: "unresolved" }, { status: 404 });
  }

  const entries = await getPositionHistory({ rid: details.rid });
  return NextResponse.json(
    { ok: true, rid: details.rid, entries },
    { headers: { "Cache-Control": "no-store" } },
  );
}
