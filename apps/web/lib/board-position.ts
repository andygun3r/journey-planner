import { darwinStopForecast, darwinTrain, nrHeadcode, nrTrainPosition, station } from "@mainline/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { BoardDeparture, BoardPosition } from "./board";
import { getDb } from "./db";

/**
 * Attaches a live "where is the train right now" position to each board row,
 * from the Network Rail overlay (nr_train_position). This is the
 * between-station positioning Darwin can't give: it turns a departure row
 * into "6 mins away — passed Hatfield, 2 late".
 *
 * Two independent sources land in nr_train_position under different keys:
 * TRUST movements (trainId = TRUST train_id, rid set via activation) and TD
 * berth steps (trainId = "TD:<headcode>", rid never set — TD doesn't carry
 * one). We match rid directly for the former, and bridge rid -> uid ->
 * headcode (nr_headcode, from the NROD schedule feed) for the latter, same
 * as service-progress.ts's TD correlation. Only reports fresher than 10
 * minutes are shown — an unreported train should read as "not tracking",
 * not display a stale, possibly wrong, location.
 *
 * One bulk query set per board; a no-op when the NR ingester hasn't run.
 */

const STALE_AFTER_MS = 10 * 60_000;

const ukHm = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});
const hhmm = (iso: string) => ukHm.format(new Date(iso));

export async function enrichBoardWithPosition(
  crs: string,
  departures: BoardDeparture[],
): Promise<BoardDeparture[]> {
  if (departures.length === 0) return departures;
  const db = getDb();

  // 1. rid for each row, by this station's scheduled departure minute.
  let forecasts: Array<{ rid: string; schedDep: string | null }>;
  try {
    forecasts = await db
      .select({ rid: darwinStopForecast.rid, schedDep: darwinStopForecast.schedDep })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.crs, crs));
  } catch {
    return departures; // NR/Darwin tables not ready — leave rows unchanged.
  }
  if (forecasts.length === 0) return departures;

  const ridByMinute = new Map<string, string>();
  for (const f of forecasts) if (f.schedDep) ridByMinute.set(f.schedDep.slice(0, 5), f.rid);

  const rids = [
    ...new Set(
      departures.map((d) => d.rid ?? ridByMinute.get(hhmm(d.scheduled))).filter(Boolean) as string[],
    ),
  ];
  if (rids.length === 0) return departures;

  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS);

  // 2. NR position for those rids (TRUST movements, correlated via activation).
  const positions = await db
    .select({
      rid: nrTrainPosition.rid,
      lastCrs: nrTrainPosition.lastCrs,
      lastEvent: nrTrainPosition.lastEventType,
      lastReportedAt: nrTrainPosition.lastReportedAt,
      lateness: nrTrainPosition.lateness,
    })
    .from(nrTrainPosition)
    .where(and(inArray(nrTrainPosition.rid, rids), gt(nrTrainPosition.lastReportedAt, staleCutoff)));

  const posByRid = new Map(positions.filter((p) => p.rid).map((p) => [p.rid as string, p]));

  // 2b. Fill gaps from TD berth steps, bridged rid -> uid -> headcode. TD rows
  // never carry a rid, so they're invisible to the query above.
  //
  // A headcode is NOT unambiguous: it's reused by many unrelated physical
  // trains across the day (and even concurrently, elsewhere on the network),
  // so nr_train_position's `TD:<headcode>` row can belong to a different
  // service entirely — seen in practice showing a Woking-Portsmouth service
  // as "passed Ipswich". Only trust it when the reported CRS is actually one
  // of this rid's own route stops.
  const ridsNeedingTd = rids.filter((r) => !posByRid.has(r));
  if (ridsNeedingTd.length > 0) {
    const routeRows = await db
      .select({ rid: darwinStopForecast.rid, crs: darwinStopForecast.crs })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.rid, ridsNeedingTd));
    const routeCrsByRid = new Map<string, Set<string>>();
    for (const r of routeRows) {
      if (!r.crs) continue;
      const set = routeCrsByRid.get(r.rid) ?? new Set<string>();
      set.add(r.crs);
      routeCrsByRid.set(r.rid, set);
    }

    const uidRows = await db
      .select({ rid: darwinTrain.rid, uid: darwinTrain.uid })
      .from(darwinTrain)
      .where(inArray(darwinTrain.rid, ridsNeedingTd));
    const uidByRid = new Map(uidRows.map((r) => [r.rid, r.uid]));
    const uids = [...new Set(uidRows.map((r) => r.uid))];

    if (uids.length > 0) {
      const hcRows = await db
        .select({ uid: nrHeadcode.uid, headcode: nrHeadcode.headcode })
        .from(nrHeadcode)
        .where(inArray(nrHeadcode.uid, uids));
      const headcodeByUid = new Map(hcRows.map((r) => [r.uid, r.headcode]));

      const headcodes = [...new Set(hcRows.map((r) => r.headcode))];
      if (headcodes.length > 0) {
        const tdRows = await db
          .select({
            headcode: nrTrainPosition.headcode,
            lastCrs: nrTrainPosition.lastCrs,
            lastEvent: nrTrainPosition.lastEventType,
            lastReportedAt: nrTrainPosition.lastReportedAt,
            lateness: nrTrainPosition.lateness,
          })
          .from(nrTrainPosition)
          .where(
            and(
              inArray(nrTrainPosition.headcode, headcodes),
              gt(nrTrainPosition.lastReportedAt, staleCutoff),
            ),
          );
        const tdByHeadcode = new Map(tdRows.filter((r) => r.headcode).map((r) => [r.headcode as string, r]));

        for (const rid of ridsNeedingTd) {
          const uid = uidByRid.get(rid);
          const headcode = uid ? headcodeByUid.get(uid) : undefined;
          const td = headcode ? tdByHeadcode.get(headcode) : undefined;
          if (td?.lastCrs && routeCrsByRid.get(rid)?.has(td.lastCrs)) posByRid.set(rid, { ...td, rid });
        }
      }
    }
  }

  if (posByRid.size === 0) return departures;

  // 3. Name the location CRS values we actually need.
  const crsToName = new Map<string, string>();
  const crsNeeded = [
    ...new Set([...posByRid.values()].map((p) => p.lastCrs).filter(Boolean) as string[]),
  ];
  if (crsNeeded.length > 0) {
    const names = await db
      .select({ crs: station.crs, name: station.name })
      .from(station)
      .where(inArray(station.crs, crsNeeded));
    for (const n of names) crsToName.set(n.crs, titleCase(n.name));
  }

  return departures.map((d) => {
    const rid = d.rid ?? ridByMinute.get(hhmm(d.scheduled));
    const p = rid ? posByRid.get(rid) : undefined;
    if (!p) return d;

    const where = p.lastCrs ? (crsToName.get(p.lastCrs) ?? p.lastCrs) : undefined;
    const verb =
      p.lastEvent === "ARRIVAL" ? "at" : p.lastEvent === "DEPARTURE" ? "departed" : "passed";
    // No station name yet (berth-only) — still say it's moving.
    const label = where ? `${verb === "at" ? "At" : cap(verb)} ${where}` : "On the move";

    const position: BoardPosition = {
      label,
      latenessMinutes:
        p.lateness !== null && p.lateness !== undefined ? Math.round(p.lateness / 60) : undefined,
      reportedAgoSeconds: p.lastReportedAt
        ? Math.round((Date.now() - p.lastReportedAt.getTime()) / 1000)
        : undefined,
      // If it hasn't reported a movement, or only a berth pass at origin, treat
      // as approaching. We keep it simple: any live NR report means it's tracked.
      approaching: false,
    };
    return { ...d, rid, position };
  });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** .MSN station names are ALL CAPS; title-case for display. */
function titleCase(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(On|Of|The|Upon|And|In|Under|Le|By)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}
