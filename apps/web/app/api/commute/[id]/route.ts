import { CommuteInput } from "@signaller/shared";
import { NextRequest, NextResponse } from "next/server";
import { deleteCommute, getCommute, updateCommute } from "@/lib/commutes";
import { getUserId } from "@/lib/current-user";
import { isUuid } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/**
 * One commute. Every handler here is scoped by userId at the lib level, so an
 * id belonging to someone else reads as "not found" rather than leaking that
 * it exists.
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const commute = await getCommute(userId, id);
  if (!commute) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  return NextResponse.json({ ok: true, commute });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const updated = await updateCommute(userId, id, parsed.data);
  if (!updated) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const deleted = await deleteCommute(userId, id);
  if (!deleted) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
