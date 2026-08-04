import { NextResponse } from "next/server";
import path from "node:path";
import { checkEtlAuth } from "@/lib/etl-auth";
import { startRawZipImportJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Accepts a raw DTD timetable zip (e.g. RJTTF512.ZIP, as downloaded from
 * NRDP or delivered via SFTP) and sends its bytes to etl's /upload endpoint,
 * which runs the full dtd2mysql -> GTFS -> Postgres pipeline — etl has the
 * memory this web container deliberately doesn't (see etl-apply.ts). This is
 * the "I just have the zip" path — no local `etl package` run required
 * first. etl and web are separate Coolify apps with no shared filesystem, so
 * the file travels in the request body rather than a shared volume path.
 */
export async function POST(req: Request) {
  const authError = await checkEtlAuth(req);
  if (authError) return authError;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
  }

  const filename = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_") || "timetable.zip";
  const bytes = Buffer.from(await file.arrayBuffer());

  const jobId = startRawZipImportJob(bytes, filename);
  return NextResponse.json({ jobId });
}
