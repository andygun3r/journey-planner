import { AccessibilityPrefsInput } from "@signaller/shared";
import { NextRequest, NextResponse } from "next/server";
import { getAccessibilityPrefs, setAccessibilityPrefs } from "@/lib/accessibility-prefs";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * Accessibility preferences: reduced motion, text size, high contrast and
 * whether status colours are paired with a symbol.
 *
 * The native app applies these alongside the system's own settings — an
 * account preference and iOS's Dynamic Type are separate signals and both
 * have to be honoured.
 */

export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const prefs = await getAccessibilityPrefs(userId);
  return NextResponse.json({ ok: true, prefs });
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  // Merge over what's stored so a client can send one field without
  // accidentally resetting the rest.
  const current = await getAccessibilityPrefs(userId);
  const parsed = AccessibilityPrefsInput.safeParse({
    ...current,
    ...(body as Record<string, unknown>),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  await setAccessibilityPrefs(userId, parsed.data);
  return NextResponse.json({ ok: true, prefs: parsed.data });
}
