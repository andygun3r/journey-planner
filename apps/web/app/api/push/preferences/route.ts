import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/current-user";
import { getPushPreferences, setPushPreferences, type PushPreferences } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Get the signed-in user's per-category push preferences. */
export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getPushPreferences(userId));
}

const PATCHABLE_KEYS = ["commuteDisruptions", "preDeparture", "networkDisruptions"] as const;

/** Update one or more of the signed-in user's push category preferences. */
export async function PATCH(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Invalid preferences" }, { status: 400 });
  }

  const patch: Partial<PushPreferences> = {};
  for (const key of PATCHABLE_KEYS) {
    const value = (body as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      return NextResponse.json({ ok: false, error: "Invalid preferences" }, { status: 400 });
    }
    patch[key] = value;
  }

  await setPushPreferences(userId, patch);
  return NextResponse.json({ ok: true });
}
