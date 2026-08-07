import { NextRequest, NextResponse } from "next/server";
import { londonDate } from "@signaller/shared";
import { resolveArrival, resolveTrainUid } from "@/lib/pin-resolution";

export const dynamic = "force-dynamic";

/**
 * Resolves one clicked board row to its train_uid, for pinning as a commute
 * leg — and its scheduled arrival at the leg's chosen destination (a board
 * row only carries a departure time and the service's overall destination
 * name, not the arrival time wherever the user is actually getting off).
 * Called once, synchronously, when the user clicks a row in the picker — a
 * failed resolution surfaces immediately ("not confirmed yet") rather than
 * saving a broken pin (decision: no lazy/pending pin state).
 */
export async function POST(req: NextRequest) {
  let body: {
    rid?: string;
    serviceId?: string;
    gtfsTripId?: string;
    targetDate?: string;
    crs?: string;
    scheduledHhmm?: string;
    destCrs?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const resolved = await resolveTrainUid(
    { rid: body.rid, serviceId: body.serviceId, gtfsTripId: body.gtfsTripId, targetDate: body.targetDate },
    { crs: body.crs, scheduledHhmm: body.scheduledHhmm },
  ).catch(() => null);

  if (!resolved) {
    return NextResponse.json({ ok: false, reason: "no-data" });
  }

  let schedArr: string | null = null;
  if (body.crs && body.destCrs) {
    const serviceDate = body.targetDate ?? londonDate();
    schedArr = await resolveArrival(resolved, body.crs, body.destCrs, serviceDate).catch(() => null);
  }

  return NextResponse.json({
    ok: true,
    trainUid: resolved.trainUid,
    gtfsTripId: resolved.gtfsTripId,
    schedArr,
  });
}
