import { NextRequest, NextResponse } from "next/server";
import { getLiveTrains } from "@/lib/live-trains";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rid = req.nextUrl.searchParams.get("rid") ?? undefined;
  try {
    const result = await getLiveTrains(rid ? 10 : 800, rid);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), count: 0, trains: [] },
      { status: 503 },
    );
  }
}
