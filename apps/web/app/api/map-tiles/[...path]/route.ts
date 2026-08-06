import { NextRequest, NextResponse } from "next/server";

/**
 * Proxies the hosted OpenRailwayMap-vector instance (openrailwaymap.app)
 * for /map, since we can't self-host the orm-db/orm-import/orm-martin/
 * orm-api/orm-proxy stack on this server. Two reasons this can't be a direct
 * browser fetch to openrailwaymap.app, per their public API:
 *
 *   1. No CORS headers on any response — a browser fetch() from our own
 *      origin is blocked outright before the app ever sees the response.
 *   2. Their usage policy requires a valid Referer/User-Agent identifying a
 *      real application; unset or generic ones 403.
 *
 * Routing every style/tile/sprite/glyph request through our own server
 * fixes both: the browser only ever talks to our domain (no CORS issue),
 * and we control the Referer sent upstream. NEXT_PUBLIC_TILES_URL should
 * point at this route's own base path, not openrailwaymap.app directly —
 * see orm-style.ts, which then treats every server-relative path in the
 * style JSON as relative to here.
 */

const UPSTREAM = "https://openrailwaymap.app";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const upstreamUrl = `${UPSTREAM}/${path.join("/")}${req.nextUrl.search}`;

  const upstreamRes = await fetch(upstreamUrl, {
    headers: {
      Referer: req.nextUrl.origin,
      "User-Agent": "Mainline (https://github.com/andygun3r/journey-planner)",
    },
  });

  const headers = new Headers();
  const contentType = upstreamRes.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=3600");

  return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers });
}
