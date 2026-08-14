import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Apple's associated-domains manifest, for the native iOS app.
 *
 * Two capabilities depend on this file being reachable at
 * `https://<host>/.well-known/apple-app-site-association`:
 *
 *   webcredentials — passkey sign-in. Better Auth derives its WebAuthn rpID
 *     from BETTER_AUTH_URL's hostname, so the app's associated domain must be
 *     that same host or the credential won't be offered.
 *   applinks — magic-link emails opening the app directly instead of Safari.
 *
 * It's a route handler rather than a file in `public/` for one reason: Apple
 * requires `application/json` on a path with no `.json` extension, and static
 * serving gets the content type wrong. Apple fetches it directly, so it must
 * be served over HTTPS with no redirect.
 */
export function GET() {
  const teamId = process.env.APPLE_TEAM_ID;
  const bundleId = process.env.APPLE_BUNDLE_ID ?? "uk.signaller.app";

  // Serving a manifest with a placeholder team id is worse than serving none:
  // iOS caches it, and the app then fails to associate until the cache expires.
  if (!teamId) {
    return NextResponse.json(
      { error: "APPLE_TEAM_ID is not configured" },
      { status: 404 },
    );
  }

  const appId = `${teamId}.${bundleId}`;

  return NextResponse.json(
    {
      webcredentials: { apps: [appId] },
      applinks: {
        details: [
          {
            appIDs: [appId],
            // Only the auth callback opens the app. Every other path stays in
            // the browser, so sharing a journey link still works on the web.
            components: [{ "/": "/auth/*" }],
          },
        ],
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        // Apple re-fetches periodically; an hour keeps changes propagating
        // without hammering the route.
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
