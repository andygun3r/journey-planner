import { NextResponse } from "next/server";
import { auth } from "./auth";
import { isAdminUser } from "./require-admin";

/**
 * Guards the ETL upload/sftp-sync routes. Allows a request through if EITHER:
 *
 *   (a) it carries a valid Better Auth session cookie for a user with
 *       role "admin" — the human clicking "run ETL" from /settings/timetable, or
 *   (b) it carries a valid Better Auth API key (the `x-api-key` header) — the
 *       unattended etl-cron nightly job, which has no session.
 *
 * Fails closed: anything else is 401. Replaces the old shared-secret
 * ETL_UPLOAD_TOKEN check.
 */
export async function checkEtlAuth(req: Request): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (isAdminUser(session?.user as { role?: string } | undefined)) {
    return null;
  }

  const providedKey = req.headers.get("x-api-key");
  if (providedKey) {
    const result = await auth.api.verifyApiKey({ body: { key: providedKey } });
    if (result.valid) return null;
  }

  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
