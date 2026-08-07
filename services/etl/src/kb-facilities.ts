/**
 * Nightly sync of station facilities/accessibility from the RDG Knowledgebase
 * feed into station_facility. Static data — the feed itself is documented as
 * refreshing at most every 24h — so a nightly run (see
 * services/etl/cron/run-and-reload-motis.sh) is enough; there's no separate
 * live poller for this half of KB (compare kb-incidents.ts).
 *
 * The exact response shape is unconfirmed until RDM registration (enhanced
 * accessibility is documented as a JSON v5.0 "stations" feed; everything
 * else in KB is XML v4.0). RawFacility below is a best guess, kept
 * deliberately permissive (all fields optional) so a wrong guess fails soft
 * — missing/renamed fields just leave the corresponding column null rather
 * than throwing — while the real payload is always retained in `raw` for
 * inspection and later column backfills.
 */

import { createDb, stationFacility } from "@signaller/db";
import { kbConfigured, kbGetJson } from "./kb-client.js";

interface RawFacility {
  crsCode?: string;
  crs?: string;
  stepFreeAccess?: boolean;
  stepFreeAccessDescription?: string;
  ticketOfficeHours?: string;
  carPark?: boolean;
  carParkSpaces?: number;
  toilets?: boolean;
  lifts?: boolean;
  waitingRoom?: boolean;
  wifi?: boolean;
  assistanceAvailable?: boolean;
  assistanceDescription?: string;
}

function toRow(f: RawFacility): (typeof stationFacility.$inferInsert) | null {
  const crs = (f.crsCode ?? f.crs)?.toUpperCase();
  if (!crs) return null;
  return {
    crs,
    stepFreeAccess: f.stepFreeAccess ?? null,
    stepFreeDescription: f.stepFreeAccessDescription ?? null,
    ticketOfficeHours: f.ticketOfficeHours ?? null,
    hasCarPark: f.carPark ?? null,
    carParkSpaces: f.carParkSpaces ?? null,
    hasToilets: f.toilets ?? null,
    hasLifts: f.lifts ?? null,
    hasWaitingRoom: f.waitingRoom ?? null,
    hasWifi: f.wifi ?? null,
    assistanceAvailable: f.assistanceAvailable ?? null,
    assistanceDescription: f.assistanceDescription ?? null,
    raw: f,
    updatedAt: new Date(),
  };
}

export async function syncStationFacilities(): Promise<void> {
  if (!kbConfigured()) {
    console.log("[etl] KB_API_KEY/KB_BASE_URL not set — skipping station facilities sync.");
    return;
  }

  const data = await kbGetJson("/stations");
  if (!Array.isArray(data)) {
    console.error("[etl] Knowledgebase stations feed returned no usable data — skipping.");
    return;
  }

  const rows = (data as RawFacility[]).map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) {
    console.error("[etl] Knowledgebase stations feed returned zero mappable rows — skipping.");
    return;
  }

  const db = createDb();
  for (const values of rows) {
    await db
      .insert(stationFacility)
      .values(values)
      .onConflictDoUpdate({ target: stationFacility.crs, set: values });
  }
  console.log(`[etl] Synced station facilities for ${rows.length} stations.`);
}
