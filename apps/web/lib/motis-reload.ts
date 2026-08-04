/**
 * Pushes a GTFS zip to motis's sidecar and triggers a reimport + restart.
 *
 * MOTIS has no live-reload API — `motis server` only serves whatever is
 * already preprocessed under /data/data, so a restart on its own picks up
 * nothing; the import has to run first. Before the per-service Coolify
 * split, this wrote the zip into a volume shared with motis and reached the
 * Docker socket directly. motis is its own Coolify app now, so the zip
 * travels over HTTP and a small sidecar container in that same app (see
 * services/motis-sidecar) does the actual `docker run .../motis import` +
 * `docker restart` — it has host socket access to its sibling motis
 * container; this process no longer needs any.
 *
 * Used only by the uploaded-bundle path (etl-apply.ts's applyBundle), which
 * runs entirely inside this web container and produces its own GTFS zip
 * without going through the etl service. The SFTP/full-timetable paths call
 * etl's own HTTP endpoints instead, which push+reimport on etl's side of the
 * pipeline directly (see etl-sftp-sync.ts).
 */

export type ReloadProgress = (line: string) => void;

export async function reloadMotis(gtfsZipPath: string, onProgress: ReloadProgress): Promise<void> {
  const baseUrl = process.env.MOTIS_REIMPORT_URL;
  const key = process.env.MOTIS_REIMPORT_KEY;
  if (!baseUrl || !key) {
    throw new Error("MOTIS_REIMPORT_URL and MOTIS_REIMPORT_KEY must be set to reload motis");
  }

  const { createReadStream } = await import("node:fs");

  onProgress("Uploading GTFS to motis sidecar...");
  const uploadRes = await fetch(new URL("/upload-gtfs", baseUrl), {
    method: "POST",
    headers: { "x-internal-key": key, "content-type": "application/octet-stream" },
    body: createReadStream(gtfsZipPath) as unknown as ReadableStream,
    duplex: "half",
  } as RequestInit);
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new Error(`motis upload-gtfs failed: ${uploadRes.status}${body ? ` ${body}` : ""}`);
  }

  onProgress("Reimporting into motis (sidecar container)...");
  const reimportRes = await fetch(new URL("/reimport", baseUrl), {
    method: "POST",
    headers: { "x-internal-key": key },
  });
  if (!reimportRes.ok) {
    const body = await reimportRes.text().catch(() => "");
    throw new Error(`motis reimport failed: ${reimportRes.status}${body ? ` ${body}` : ""}`);
  }
  onProgress("motis reimported and restarted.");
}
