import { NextResponse } from "next/server";
import { getLiveTrains } from "@/lib/live-trains";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getLiveTrains();
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
