import { CommuteInput } from "@signaller/shared";
import { NextRequest, NextResponse } from "next/server";
import { createCommute, listCommutes } from "@/lib/commutes";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * Commute CRUD for the native app.
 *
 * The web UI drives these through server actions in `app/commute/actions.ts`,
 * which can't be called over HTTP. These routes call the same `lib/` functions
 * so behaviour can't drift; the only difference is that they return JSON
 * instead of revalidating a path and redirecting.
 */

export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const commutes = await listCommutes(userId);
  return NextResponse.json({ ok: true, commutes });
}

export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const parsed = CommuteInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const id = await createCommute(userId, parsed.data);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
