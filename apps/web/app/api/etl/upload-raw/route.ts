import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkEtlAuth } from "@/lib/etl-auth";
import { startRawZipImportJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Shared with etl-cron via the dtd-archive volume (see docker-compose.yml).
// "incoming" keeps uploads out of etl-cron's own archive/ subfolder, which
// its SFTP sync manages independently.
const HOST_INCOMING_DIR = path.join(process.env.ETL_ARCHIVE_DIR ?? "/data/dtd", "incoming");
// etl-cron mounts the same volume at /data/dtd, so an uploaded file's path
// there is identical — only the containers differ, not the mount point.
const CONTAINER_INCOMING_DIR = "/data/dtd/incoming";

/**
 * Accepts a raw DTD timetable zip (e.g. RJTTF512.ZIP, as downloaded from
 * NRDP or delivered via SFTP) and runs the full dtd2mysql -> GTFS -> Postgres
 * pipeline on it inside etl-cron, which has the memory this web container
 * deliberately doesn't (see etl-apply.ts). This is the "I just have the zip"
 * path — no local `etl package` run required first.
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
  await mkdir(HOST_INCOMING_DIR, { recursive: true });
  const hostPath = path.join(HOST_INCOMING_DIR, filename);
  await writeFile(hostPath, Buffer.from(await file.arrayBuffer()));

  const containerPath = path.join(CONTAINER_INCOMING_DIR, filename);
  const jobId = startRawZipImportJob(hostPath, containerPath);
  return NextResponse.json({ jobId });
}
