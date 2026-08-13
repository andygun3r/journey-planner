import { createReadStream } from "node:fs";

/**
 * Pushes a produced GTFS zip to the motis app's sidecar (see
 * services/motis-sidecar) and triggers a reimport + restart there. motis is
 * its own Coolify app now, with no shared gtfs-data volume — this replaces
 * writing the file to ETL_GTFS_OUT_DIR and letting motis read it locally.
 */
/**
 * Uploads an OSM extract to the motis sidecar, which is what turns street
 * routing on — the next reimport sees the file and writes an `osm:` config
 * (see services/motis-sidecar/src/index.ts).
 *
 * Separate from pushGtfsAndReimport because the two have very different
 * cadences: the timetable changes nightly, the footpath network does not.
 * Uploading a ~1.5GB extract on every timetable run would be pure waste.
 */
export async function pushOsmExtract(osmPath: string): Promise<boolean> {
  const baseUrl = process.env.MOTIS_REIMPORT_URL;
  const key = process.env.MOTIS_REIMPORT_KEY;
  if (!baseUrl || !key) {
    console.log("[etl] MOTIS_REIMPORT_URL/MOTIS_REIMPORT_KEY not set — skipping OSM upload.");
    return false;
  }

  console.log("[etl] uploading OSM extract to motis sidecar (this is large; expect it to take a while)...");
  let res: Response;
  try {
    res = await fetch(new URL("/upload-osm", baseUrl), {
      method: "POST",
      headers: { "x-internal-key": key, "content-type": "application/octet-stream" },
      body: createReadStream(osmPath) as unknown as ReadableStream,
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    throw new Error(`motis upload-osm: request to ${baseUrl} failed`, { cause: err });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`motis upload-osm failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
  console.log("[etl] OSM extract uploaded — street routing applies from the next reimport.");
  return true;
}

export async function pushGtfsAndReimport(gtfsZipPath: string): Promise<void> {
  const baseUrl = process.env.MOTIS_REIMPORT_URL;
  const key = process.env.MOTIS_REIMPORT_KEY;
  if (!baseUrl || !key) {
    console.log("[etl] MOTIS_REIMPORT_URL/MOTIS_REIMPORT_KEY not set — skipping motis reimport.");
    return;
  }

  console.log("[etl] uploading GTFS zip to motis sidecar...");
  let uploadRes: Response;
  try {
    uploadRes = await fetch(new URL("/upload-gtfs", baseUrl), {
      method: "POST",
      headers: { "x-internal-key": key, "content-type": "application/octet-stream" },
      body: createReadStream(gtfsZipPath) as unknown as ReadableStream,
      duplex: "half",
    } as RequestInit);
  } catch (err) {
    throw new Error(`motis upload-gtfs: request to ${baseUrl} failed`, { cause: err });
  }
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new Error(`motis upload-gtfs failed: ${uploadRes.status}${body ? ` ${body}` : ""}`);
  }

  console.log("[etl] triggering motis reimport...");
  let reimportRes: Response;
  try {
    reimportRes = await fetch(new URL("/reimport", baseUrl), {
      method: "POST",
      headers: { "x-internal-key": key },
    });
  } catch (err) {
    throw new Error(`motis reimport: request to ${baseUrl} failed`, { cause: err });
  }
  if (!reimportRes.ok) {
    const body = await reimportRes.text().catch(() => "");
    throw new Error(`motis reimport failed: ${reimportRes.status}${body ? ` ${body}` : ""}`);
  }
  console.log("[etl] motis reimported and restarted.");
}
