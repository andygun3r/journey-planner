import { NextResponse } from "next/server";
import { fetchServiceDetails, serviceDetailsConfigured } from "@/lib/service-details";

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
  return NextResponse.json(
    { ok: true, service: details },
    { headers: { "Cache-Control": "public, max-age=15" } },
  );
}
