import { NextRequest, NextResponse } from "next/server";
import { endActiveRun, startRunChecked } from "@/lib/commute-runs";
import { getUserId } from "@/lib/current-user";
import { isUuid } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/**
 * Start / end a commute run — "I'm travelling now", and "I'm there".
 *
 * Ownership checks live in `startRunChecked`, shared with the web's
 * `startCommuteAction`. Don't re-implement them here: both the commute id and
 * the leg id come from the client, and the two checks are exactly the kind of
 * thing that drifts when it's written twice.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const direction = body.direction;
  if (direction !== "am" && direction !== "pm") {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "direction must be am or pm" },
      { status: 400 },
    );
  }

  for (const field of ["originCrs", "originLabel", "destCrs", "destLabel"]) {
    if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
      return NextResponse.json(
        { ok: false, reason: "bad-request", error: `${field} is required` },
        { status: 400 },
      );
    }
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const result = await startRunChecked(userId, {
    commuteId: id,
    commuteLegId: typeof body.commuteLegId === "string" ? body.commuteLegId : null,
    direction,
    originCrs: body.originCrs as string,
    originLabel: body.originLabel as string,
    destCrs: body.destCrs as string,
    destLabel: body.destLabel as string,
    // The journey snapshot is optional — without it the run just expires on
    // the grace window instead of the live arrival estimate.
    journey: (body.journey as never) ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: "not-found", error: result.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true, run: result.run }, { status: 201 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  await endActiveRun(userId, id, "manual");
  return NextResponse.json({ ok: true });
}
