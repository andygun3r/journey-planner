import { createEngine, type RawDeparture } from "@signaller/routing-adapter";
import { normaliseCrs, operatorFromRouteName } from "@signaller/shared";
import { darwinStationMessage } from "@signaller/db";
import { sql } from "drizzle-orm";
import { enrichBoardWithDarwin } from "./darwin-board";
import { enrichBoardWithFormation } from "./darwin-formation";
import { enrichBoardWithPosition } from "./board-position";
import { orderByExpectedDeparture } from "./board-order";
import { type Disruption, fetchStationDisruptions } from "./disruptions";
import { track, type Timer } from "./timing";
import { fetchLdbwsBoard, ldbwsConfigured } from "./ldbws";
import { getRtppmByOperatorName } from "./rtppm";
import { stationName } from "./stations";
import { getDb } from "./db";
import { vstpDeparturesForBoard } from "./vstp-board";
import { ukHhmm } from "./uk-time";

/** Where a board's data came from — drives the UI provenance badge. */
export type BoardSource = "ldbws" | "darwin" | "timetable";

/** One carriage in a train formation. */
export interface Coach {
  number: string;
  first: boolean;
  /** Raw class string from the feed, e.g. "First" / "Standard". */
  coachClass?: string;
  /** Loading percentage (0-100) when the operator reports it. */
  loading?: number;
}

/** A single row on a live departure board. */
export interface BoardDeparture {
  tripId?: string;
  /** Darwin run id, once the live overlay has matched this trip. */
  rid?: string;
  originName?: string;
  originCrs?: string;
  destinationName: string;
  destinationCrs?: string;
  operator?: string;
  /** ISO instant. Never a bare "HH:MM" — see `live`. */
  scheduled: string;
  /**
   * Live estimated departure when Darwin has one, as an ISO INSTANT.
   *
   * Every consumer does `new Date(live)`. darwin-board.ts used to assign the
   * raw "HH:MM" string here, which produced Invalid Date in the board's
   * formatter and a silently blank countdown; keep this an instant.
   */
  live?: string;
  platform?: string;
  platformChanged: boolean;
  /** Human status: on time, Exp. HH:MM, Cancelled, Delayed. */
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  /** Human-readable cause, e.g. "delayed by a late running train in front". */
  reason?: string;
  /** Number of coaches, when the operator reports a formation. */
  coachCount?: number;
  /** Per-coach detail (number, class, live loading) when available. */
  coaches?: Coach[];
  /** True once real-time data has been applied to this row. */
  hasLive: boolean;
  /** Live "where is it right now" from Network Rail (correlated by rid). */
  position?: BoardPosition;
  /** Operator's rolling last-hour punctuality (RTPPM), 0-100, when known. */
  operatorPunctuality?: number;
  /**
   * True when live running has moved this row out of its booked position.
   * The board orders by expected departure, so a delayed train drops down the
   * list — the flag lets the UI say that rather than appear to shuffle.
   */
  movedFromSchedule?: boolean;
}

/** Live running position for a board row, from the Network Rail overlay. */
export interface BoardPosition {
  /** Human status: where the train physically is at the moment. */
  label: string;
  /** Seconds late (+) / early (−) at the last report. */
  latenessMinutes?: number;
  /** How long ago Network Rail last reported it, in seconds. */
  reportedAgoSeconds?: number;
  /** True while the train hasn't left its origin yet. */
  approaching: boolean;
  /**
   * True when the last report is old enough that the position may no longer be
   * where the train actually is. The row is still shown — a quiet feed is not
   * the same as a train that vanished — but the UI must say the age out loud
   * rather than present a stale location as current.
   */
  stale?: boolean;
}

export interface BoardResult {
  crs: string;
  stationName: string;
  generatedAt: string;
  /** True when the board carries real-time data (LDBWS, or Darwin overlay). */
  live: boolean;
  source: BoardSource;
  /** When filtered, the name of the "calling at" station. */
  filterName?: string;
  /** Station disruption notices (NRCC messages from LDBWS). */
  messages: string[];
  /** Structured active disruptions from the Disruptions API. */
  disruptions: Disruption[];
  departures: BoardDeparture[];
  arrivals: BoardDeparture[];
}

export type BoardOutcome =
  | { ok: true; board: BoardResult }
  | { ok: false; reason: "engine-offline" | "bad-request" | "unknown-station" };

/** NRCC station messages for the MOTIS-fallback board path (LDBWS already carries its own). */
async function fetchStationMessages(crs: string): Promise<string[]> {
  const db = getDb();
  try {
    const rows = await db
      .select({ html: darwinStationMessage.html })
      .from(darwinStationMessage)
      .where(sql`${darwinStationMessage.crsList} @> ARRAY[${crs}]::text[]`);
    return rows.map((r) => r.html);
  } catch {
    return [];
  }
}

/**
 * Loosely-matchable key for an operator display name — strips case, spacing
 * and punctuation so "South Western Railway" (LDBWS) and the Disruptions
 * API's own tocName line up even if one has a stray "&"/hyphen the other
 * doesn't. Exported for the commute network-log filter (commute-network-log.ts),
 * which does the same RTPPM-style fuzzy join against a different feed.
 */
export function normaliseOperatorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Attach each row's operator's rolling punctuality figure, where matched. */
async function withPunctuality(departures: BoardDeparture[]): Promise<BoardDeparture[]> {
  if (departures.length === 0) return departures;
  const rtppm = await getRtppmByOperatorName().catch(() => new Map());
  if (rtppm.size === 0) return departures;
  return departures.map((d) => {
    if (!d.operator) return d;
    const match = rtppm.get(normaliseOperatorName(d.operator));
    if (!match?.rollingPpm) return d;
    return { ...d, operatorPunctuality: Math.round(match.rollingPpm) };
  });
}

function scheduledRow(raw: RawDeparture): BoardDeparture {
  return {
    tripId: raw.tripId,
    destinationName: raw.destinationName ?? raw.headsign ?? "",
    destinationCrs: raw.destinationStopId,
    operator: operatorFromRouteName(raw.routeName),
    scheduled: raw.scheduled,
    live: raw.live,
    // The engine's "platform" is the .MSN station-level stop_desc (identical
    // for every train here), not a real platform number — real platforms come
    // from Darwin. Don't show the misleading placeholder.
    platform: undefined,
    platformChanged: false,
    status: raw.cancelled ? "cancelled" : "scheduled",
    hasLive: false,
  };
}

function scheduledArrivalRow(raw: RawDeparture): BoardDeparture {
  return {
    tripId: raw.tripId,
    originName: raw.originName ?? raw.headsign ?? "",
    originCrs: raw.originStopId,
    destinationName: raw.destinationName ?? "",
    destinationCrs: raw.destinationStopId,
    operator: operatorFromRouteName(raw.routeName),
    scheduled: raw.scheduled,
    live: raw.live,
    platform: undefined,
    platformChanged: false,
    status: raw.cancelled ? "cancelled" : "scheduled",
    hasLive: false,
  };
}

/**
 * Order rows by when they will actually leave, tagging any the live picture
 * has displaced. Applied to both source paths so the two boards behave alike.
 */
function inExpectedOrder(departures: BoardDeparture[]): BoardDeparture[] {
  return orderByExpectedDeparture(departures).map(({ departure, movedFromSchedule }) =>
    movedFromSchedule ? { ...departure, movedFromSchedule } : departure,
  );
}

function inExpectedArrivalOrder(arrivals: BoardDeparture[]): BoardDeparture[] {
  return orderByExpectedDeparture(arrivals).map(({ departure }) => departure);
}

function departureKey(d: BoardDeparture): string {
  const minute = ukHhmm(d.scheduled) ?? d.scheduled;
  return `${minute}|${d.destinationCrs ?? ""}|${d.destinationName.toLowerCase()}`;
}

function mergeVstpDepartures(
  scheduled: BoardDeparture[],
  vstp: BoardDeparture[],
): BoardDeparture[] {
  if (vstp.length === 0) return scheduled;
  const seen = new Set(scheduled.map(departureKey));
  const merged = [...scheduled];
  for (const row of vstp) {
    const key = departureKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

export async function getBoard(
  crsInput: string,
  when?: string,
  limit = 20,
  callingAt?: string,
  /**
   * Optional. When passed, each stage of the pipeline is timed and reported in
   * the response's Server-Timing header. Callers that don't care omit it and
   * pay nothing.
   */
  timer?: Timer,
): Promise<BoardOutcome> {
  let crs: string;
  try {
    crs = normaliseCrs(crsInput);
  } catch {
    return { ok: false, reason: "bad-request" };
  }

  const name = await stationName(crs);
  // stationName echoes the CRS back when it doesn't know the station.
  if (name === crs) return { ok: false, reason: "unknown-station" };

  // Normalise an optional "calling at" filter station.
  let filterCrs: string | undefined;
  if (callingAt) {
    try {
      filterCrs = normaliseCrs(callingAt);
    } catch {
      filterCrs = undefined;
    }
  }

  // Active disruptions for this station, fetched alongside the board (never
  // blocks it — returns [] on any failure).
  const disruptionsPromise = fetchStationDisruptions(crs).catch(() => []);

  // Primary source: LDBWS live board (real platforms, live estimates, messages).
  // "when" is only meaningful to the timetable engine — LDBWS is always "now".
  if (ldbwsConfigured() && !when) {
    const ldbws = await track(timer, "ldbws", fetchLdbwsBoard(crs, limit, filterCrs));
    // With a filter, an empty result is authoritative ("nothing calls there") —
    // don't fall through to the unfiltered MOTIS board. Without a filter, an
    // empty LDBWS result means fall back.
    if (ldbws && (ldbws.departures.length > 0 || ldbws.arrivals.length > 0 || filterCrs)) {
      for (const d of ldbws.departures) {
        if (!d.destinationName && d.destinationCrs) {
          d.destinationName = await stationName(d.destinationCrs);
        }
      }
      const ldbwsArrivals = filterCrs
        ? ((await track(timer, "ldbws-arrivals", fetchLdbwsBoard(crs, limit, filterCrs, "from")))
            ?.arrivals ?? [])
        : ldbws.arrivals;
      for (const d of ldbwsArrivals) {
        if (!d.originName && d.originCrs) {
          d.originName = await stationName(d.originCrs);
        }
        if (!d.destinationName && d.destinationCrs) {
          d.destinationName = await stationName(d.destinationCrs);
        }
      }
      // Fill coach formation from Darwin where LDBWS didn't provide it, then
      // overlay the live Network Rail running position (where the train is now).
      const withFormation = await track(
        timer,
        "formation",
        enrichBoardWithFormation(crs, ldbws.departures),
      );
      const withPosition = await track(
        timer,
        "position",
        enrichBoardWithPosition(crs, withFormation),
      );
      const departures = inExpectedOrder(
        await track(timer, "punctuality", withPunctuality(withPosition)),
      );
      const arrivals = inExpectedArrivalOrder(await withPunctuality(ldbwsArrivals));
      return {
        ok: true,
        board: {
          crs,
          stationName: ldbws.stationName || name,
          generatedAt: ldbws.generatedAt,
          live: true,
          source: "ldbws",
          filterName: ldbws.filterName,
          messages: ldbws.messages,
          disruptions: await disruptionsPromise,
          departures,
          arrivals,
        },
      };
    }
  }

  // Fallback: MOTIS scheduled board, overlaid with any Darwin DB forecasts.
  //
  // createEngine() is inside the try on purpose: it throws when MOTIS_URL is
  // unset, and that used to escape as a 500. An unconfigured routing engine is
  // the same situation for a caller as an unreachable one, so both report
  // engine-offline and the board degrades instead of erroring.
  let raw: RawDeparture[];
  let rawArrivals: RawDeparture[];
  try {
    const engine = createEngine();
    [raw, rawArrivals] = await track(
      timer,
      "motis",
      Promise.all([
        engine.departures({ stopId: crs, when, limit }),
        engine.arrivals({ stopId: crs, when, limit }),
      ]),
    );
  } catch {
    return { ok: false, reason: "engine-offline" };
  }

  const scheduled = raw.map(scheduledRow);
  const scheduledArrivals = rawArrivals
    .map(scheduledArrivalRow)
    .filter((row) => !filterCrs || row.originCrs === filterCrs);
  const vstp = when
    ? []
    : await track(timer, "vstp", vstpDeparturesForBoard(crs, new Date(), limit).catch(() => []));
  const scheduledWithVstp = mergeVstpDepartures(scheduled, vstp);
  const { departures: darwinDepartures, live } = await track(
    timer,
    "darwin",
    enrichBoardWithDarwin(crs, scheduledWithVstp),
  );

  for (const d of darwinDepartures) {
    if (!d.destinationName && d.destinationCrs) {
      d.destinationName = await stationName(d.destinationCrs);
    }
  }
  for (const d of scheduledArrivals) {
    if (!d.originName && d.originCrs) {
      d.originName = await stationName(d.originCrs);
    }
  }

  // Same formation/position enrichment as the LDBWS path — previously skipped
  // here, leaving fallback boards without coach detail or live NR position.
  const withFormation = await track(
    timer,
    "formation",
    enrichBoardWithFormation(crs, darwinDepartures),
  );
  const withPosition = await track(timer, "position", enrichBoardWithPosition(crs, withFormation));
  const departures = inExpectedOrder(
    await track(timer, "punctuality", withPunctuality(withPosition)),
  );
  const arrivals = inExpectedArrivalOrder(
    await track(timer, "arrival-punctuality", withPunctuality(scheduledArrivals)),
  );

  return {
    ok: true,
    board: {
      crs,
      stationName: name,
      generatedAt: new Date().toISOString(),
      live,
      source: live ? "darwin" : "timetable",
      messages: await fetchStationMessages(crs),
      disruptions: await disruptionsPromise,
      departures,
      arrivals,
    },
  };
}
