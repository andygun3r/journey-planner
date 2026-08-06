import { NextRequest, NextResponse } from "next/server";
import { normaliseCrs } from "@signaller/shared";
import { getUserId } from "@/lib/current-user";
import { addFavourite, listFavourites, removeFavourite } from "@/lib/favourites";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const favourites = await listFavourites(userId);
  return NextResponse.json({ favourites });
}

function parsePair(body: unknown): { from: string; to: string } | null {
  const b = body as { from?: unknown; to?: unknown };
  if (typeof b?.from !== "string" || typeof b?.to !== "string") return null;
  try {
    const from = normaliseCrs(b.from);
    const to = normaliseCrs(b.to);
    if (from === to) return null;
    return { from, to };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pair = parsePair(await req.json().catch(() => null));
  if (!pair) return NextResponse.json({ ok: false, error: "Invalid stations" }, { status: 400 });
  await addFavourite(userId, pair.from, pair.to);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pair = parsePair(await req.json().catch(() => null));
  if (!pair) return NextResponse.json({ ok: false, error: "Invalid stations" }, { status: 400 });
  await removeFavourite(userId, pair.from, pair.to);
  return NextResponse.json({ ok: true });
}
