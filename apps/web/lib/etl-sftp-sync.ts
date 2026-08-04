import type { ApplyProgress } from "./etl-apply";

/**
 * Calls one of etl's or nr-ingest's internal HTTP endpoints. Both services
 * are separate Coolify apps from web now, with no shared Docker socket to
 * `docker exec` into (the old approach) — see services/etl/src/server.ts and
 * services/nr-ingest/src/server.ts for what's on the other end.
 */
async function callService(
  onProgress: ApplyProgress,
  label: string,
  baseUrlEnv: string,
  keyEnv: string,
  path: string,
): Promise<void> {
  const baseUrl = process.env[baseUrlEnv];
  const key = process.env[keyEnv];
  if (!baseUrl || !key) {
    throw new Error(`${baseUrlEnv} and ${keyEnv} must be set to run ${label}`);
  }

  onProgress(`[${label}] running ${path}`);
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "x-internal-key": key },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} ${path} failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
}

async function runEtlCronTimetable(onProgress: ApplyProgress): Promise<void> {
  // etl's /timetable endpoint pushes the produced GTFS to motis's sidecar and
  // triggers the reimport+restart itself (see services/etl/src/commands.ts) —
  // this used to be a separate step here, calling back into a shared volume
  // web and etl-cron both mounted, which no longer exists once they're
  // separate Coolify apps.
  await callService(onProgress, "etl", "ETL_URL", "ETL_INTERNAL_KEY", "/timetable");
  onProgress("Done.");
}

/**
 * On-demand SFTP pull-and-import. etl's `/timetable` endpoint already applies
 * every SFTP file not yet recorded in etl_run (monthly full + daily
 * updates), oldest first — see services/etl/src/commands.ts.
 */
export async function syncTimetableFromSftp(onProgress: ApplyProgress): Promise<void> {
  await runEtlCronTimetable(onProgress);
}

/**
 * On-demand SFTP sweep for every rail data drop the deployment understands:
 * DTD timetable, DTD fares, NR SMART/TPS reference files, and Network Rail
 * Track Model snapshots. Each underlying command is idempotent/no-op when its
 * SFTP folder has nothing new.
 */
export async function syncAllRailDataFromSftp(onProgress: ApplyProgress): Promise<void> {
  await runEtlCronTimetable(onProgress);
  await callService(onProgress, "etl", "ETL_URL", "ETL_INTERNAL_KEY", "/fares");

  await callService(onProgress, "nr", "NR_INGEST_URL", "NR_INGEST_INTERNAL_KEY", "/reference-sftp");

  await callService(onProgress, "etl", "ETL_URL", "ETL_INTERNAL_KEY", "/track-model-sftp");
  onProgress("All SFTP rail data sync complete.");
}

/**
 * Uploads a raw DTD timetable zip's bytes to etl's /upload endpoint and runs
 * the full pipeline on it there. etl and web have no shared filesystem/volume
 * now that they're separate Coolify apps, so the file travels in the request
 * body rather than by shared path.
 */
export async function importUploadedTimetableZip(zipBytes: Buffer, filename: string, onProgress: ApplyProgress): Promise<void> {
  const baseUrl = process.env.ETL_URL;
  const key = process.env.ETL_INTERNAL_KEY;
  if (!baseUrl || !key) {
    throw new Error("ETL_URL and ETL_INTERNAL_KEY must be set to upload a timetable zip");
  }

  onProgress(`[etl] uploading ${filename}...`);
  const res = await fetch(new URL("/upload", baseUrl), {
    method: "POST",
    headers: { "x-internal-key": key, "x-filename": filename, "content-type": "application/octet-stream" },
    body: new Uint8Array(zipBytes),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`etl upload failed: ${res.status}${body ? ` ${body}` : ""}`);
  }

  // etl's /upload endpoint runs the pipeline and pushes+reimports into motis
  // itself once the import succeeds — see importTimetableZip in
  // services/etl/src/commands.ts.
  onProgress("Done.");
}
