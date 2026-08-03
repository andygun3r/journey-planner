import { NextResponse } from "next/server";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkEtlAuth } from "@/lib/etl-auth";
import { startApplyJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Receives a bundle produced locally by `etl package` (services/etl) and
 * kicks off a background job to load it into Postgres + reimport motis — see
 * lib/etl-apply.ts. Exists so the low-memory production server never has to
 * run dtd2mysql itself; that heavy conversion happens on the uploader's own
 * machine instead.
 */
export async function POST(req: Request) {
  const authError = await checkEtlAuth(req);
  if (authError) return authError;

  const form = await req.formData();
  const file = form.get("bundle");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing 'bundle' file field" }, { status: 400 });
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "etl-upload-"));
  const bundlePath = path.join(tmpDir, "bundle.tar.gz");
  await writeFile(bundlePath, Buffer.from(await file.arrayBuffer()));

  const jobId = startApplyJob(bundlePath);
  return NextResponse.json({ jobId });
}
