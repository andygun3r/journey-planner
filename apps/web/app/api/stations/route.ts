import { NextRequest, NextResponse } from "next/server";
import { searchPlaces } from "@/lib/os-places";
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
    if (q == null) {
      return NextResponse.json(stations, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }

    const ranked = rank(stations, q);

    // `?places=1` opts a caller into free-text place/address results as well.
    // They're returned in a separate array, never merged into the station
    // list: rail comes first in this app, and a station must never lose its
    // place in the list to a similarly-named shop.
    if (req.nextUrl.searchParams.get("places") !== "1") {
      return NextResponse.json(ranked, { headers: { "Cache-Control": "public, max-age=300" } });
    }

    // Fewer place rows once stations already fill the list, so the dropdown
    // stays a glanceable length either way.
    const places = await searchPlaces(q, ranked.length >= 4 ? 3 : 5).catch(() => []);

    return NextResponse.json(
      { stations: ranked, places },
      // Places come from a metered API — cache a little longer than the
      // station list, which is served from memory anyway.
      { headers: { "Cache-Control": "public, max-age=600" } },
    );
  } catch {
    return NextResponse.json([], { status: 503 });
  }
}
