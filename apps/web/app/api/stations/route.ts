import { NextResponse } from "next/server";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stations = await getStations();
    return NextResponse.json(stations, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return NextResponse.json([], { status: 503 });
  }
}
