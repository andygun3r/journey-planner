import { nrVstpSchedule, station } from "@signaller/db";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BoardDeparture } from "./board";
import { getDb } from "./db";
import { hhmmToIso, londonDateKey } from "./uk-time";

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const out = String(value).trim();
  return out.length > 0 ? out : undefined;
}

function hhmm(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const compact = /^(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}:${compact[2]}`;
  const colon = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (colon) return `${colon[1]!.padStart(2, "0")}:${colon[2]}`;
  return undefined;
}

function tiplocOf(location: Json): string | undefined {
  return str(obj(obj(obj(location).location).tiploc).tiploc_id)?.toUpperCase();
}

function departureTime(location: Json): string | undefined {
  return (
    hhmm(location.public_departure) ??
    hhmm(location.public_departure_time) ??
    hhmm(location.working_departure) ??
    hhmm(location.working_departure_time)
  );
}

function nameForTiploc(tiploc: string | undefined, names: Map<string, string>): string {
  return (tiploc ? names.get(tiploc) : undefined) ?? tiploc ?? "Unknown destination";
}

/** Active VSTP trains from this CRS that the static timetable may not know yet. */
export async function vstpDeparturesForBoard(
  crs: string,
  anchor = new Date(),
  limit = 20,
): Promise<BoardDeparture[]> {
  const db = getDb();
  const stationRows = await db
    .select({ tiplocs: station.tiplocs })
    .from(station)
    .where(eq(station.crs, crs))
    .limit(1);
  const tiplocs = new Set(stationRows[0]?.tiplocs.map((t) => t.toUpperCase()) ?? []);
  if (tiplocs.size === 0) return [];

  const serviceDate = londonDateKey(anchor);
  const schedules = await db
    .select({
      id: nrVstpSchedule.id,
      headcode: nrVstpSchedule.headcode,
      destTiploc: nrVstpSchedule.destTiploc,
      startDate: nrVstpSchedule.startDate,
      endDate: nrVstpSchedule.endDate,
      schedule: nrVstpSchedule.schedule,
    })
    .from(nrVstpSchedule)
    .where(
      and(
        or(isNull(nrVstpSchedule.startDate), lte(nrVstpSchedule.startDate, serviceDate)),
        or(isNull(nrVstpSchedule.endDate), gte(nrVstpSchedule.endDate, serviceDate)),
      ),
    );

  const destinationTiplocs = [...new Set(schedules.map((s) => s.destTiploc).filter(Boolean) as string[])];
  const destinationArray: SQL = sql`ARRAY[${sql.join(
    destinationTiplocs.map((t) => sql`${t.toUpperCase()}`),
    sql`, `,
  )}]::text[]`;
  const destinationRows =
    destinationTiplocs.length > 0
      ? await db
          .select({ crs: station.crs, name: station.name, tiplocs: station.tiplocs })
          .from(station)
          .where(sql`${station.tiplocs} && ${destinationArray}`)
      : [];
  const nameByTiploc = new Map<string, string>();
  const crsByTiploc = new Map<string, string>();
  for (const s of destinationRows) {
    for (const tpl of s.tiplocs) {
      nameByTiploc.set(tpl.toUpperCase(), s.name);
      crsByTiploc.set(tpl.toUpperCase(), s.crs);
    }
  }

  const departures: BoardDeparture[] = [];
  for (const s of schedules) {
    const locations = Array.isArray(s.schedule) ? s.schedule.map(obj) : [];
    const here = locations.find((location) => {
      const tpl = tiplocOf(location);
      return Boolean(tpl && tiplocs.has(tpl));
    });
    if (!here) continue;

    const dep = departureTime(here);
    const scheduled = hhmmToIso(dep, anchor);
    if (!scheduled) continue;
    const destTiploc = s.destTiploc?.toUpperCase();
    departures.push({
      tripId: undefined,
      destinationName: nameForTiploc(destTiploc, nameByTiploc),
      destinationCrs: destTiploc ? crsByTiploc.get(destTiploc) : undefined,
      operator: undefined,
      scheduled,
      platform: undefined,
      platformChanged: false,
      status: "scheduled",
      reason: s.headcode ? `Short-notice service ${s.headcode}` : "Short-notice service",
      hasLive: false,
    });
  }

  return departures
    .filter((d) => Date.parse(d.scheduled) >= anchor.getTime() - 5 * 60_000)
    .sort((a, b) => Date.parse(a.scheduled) - Date.parse(b.scheduled))
    .slice(0, limit);
}
