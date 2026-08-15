import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/current-user";
import { clearDeviceToken, saveDeviceToken } from "@/lib/push";

export const dynamic = "force-dynamic";

/** APNs tokens are hex; reject anything else before it reaches the database. */
const TOKEN_RE = /^[0-9a-f]{64,200}$/i;

/**
 * APNs device registration for the native iOS app.
 *
 * `/api/push` stays as it is for Web Push — the two live side by side because
 * a user may well have the browser subscribed *and* the app installed, and
 * both should buzz.
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { token?: unknown; environment?: unknown; platform?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "token must be a hex APNs device token" },
      { status: 400 },
    );
  }

  // Default to production: a sandbox token sent to the production APNs host
  // fails loudly, which is the safer way round to be wrong.
  const environment = body.environment === "sandbox" ? "sandbox" : "production";
  const platform = typeof body.platform === "string" ? body.platform : "ios";

  await saveDeviceToken(userId, token, environment, platform);
  return NextResponse.json({ ok: true });
}

/** Unregister one device — on sign-out, or when the user turns push off. */
export async function DELETE(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "token is required" },
      { status: 400 },
    );
  }

  await clearDeviceToken(token);
  return NextResponse.json({ ok: true });
}
