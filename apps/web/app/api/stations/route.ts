import { NextRequest, NextResponse } from "next/server";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

/** Rank stations for a typeahead query (exact CRS → prefix → word → contains). */
function rank(stations: { crs: string; name: string }[], query: string) {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const exactCrs = [];
  const prefix = [];
  const word = [];
  const contains = [];
  for (const s of stations) {
    const name = s.name.toLowerCase();
    if (s.crs.toLowerCase() === q) exactCrs.push(s);
    else if (name.startsWith(q)) prefix.push(s);
    else if (name.includes(` ${q}`)) word.push(s);
    else if (name.includes(q)) contains.push(s);
    if (exactCrs.length + prefix.length + word.length + contains.length > 60) break;
  }
  return [...exactCrs, ...prefix, ...word, ...contains].slice(0, 20);
}

export async function GET(req: NextRequest) {
  try {
    const stations = await getStations();
    const q = req.nextUrl.searchParams.get("q");
    // With ?q=, return a ranked shortlist (typeahead). Without, the full list
    // (kept for callers that still embed it), cached for 5 min.
    const body = q != null ? rank(stations, q) : stations;
    return NextResponse.json(body, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return NextResponse.json([], { status: 503 });
  }
}
