import { createReadStream } from "node:fs";

/**
 * Pushes a produced GTFS zip to the motis app's sidecar (see
 * services/motis-sidecar) and triggers a reimport + restart there. motis is
 * its own Coolify app now, with no shared gtfs-data volume — this replaces
 * writing the file to ETL_GTFS_OUT_DIR and letting motis read it locally.
 */
export async function pushGtfsAndReimport(gtfsZipPath: string): Promise<void> {
  const baseUrl = process.env.MOTIS_REIMPORT_URL;
  const key = process.env.MOTIS_REIMPORT_KEY;
  if (!baseUrl || !key) {
    console.log("[etl] MOTIS_REIMPORT_URL/MOTIS_REIMPORT_KEY not set — skipping motis reimport.");
    return;
  }

  console.log("[etl] uploading GTFS zip to motis sidecar...");
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

  console.log("[etl] triggering motis reimport...");
  const reimportRes = await fetch(new URL("/reimport", baseUrl), {
    method: "POST",
    headers: { "x-internal-key": key },
  });
  if (!reimportRes.ok) {
    const body = await reimportRes.text().catch(() => "");
    throw new Error(`motis reimport failed: ${reimportRes.status}${body ? ` ${body}` : ""}`);
  }
  console.log("[etl] motis reimported and restarted.");
}
