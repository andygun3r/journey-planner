import { createEngine, type RawDeparture } from "@mainline/routing-adapter";
import { normaliseCrs, operatorFromRouteName } from "@mainline/shared";
import { enrichBoardWithDarwin } from "./darwin-board";
import { enrichBoardWithFormation } from "./darwin-formation";
import { enrichBoardWithPosition } from "./board-position";
import { type Disruption, fetchStationDisruptions } from "./disruptions";
import { fetchLdbwsBoard, ldbwsConfigured } from "./ldbws";
import { stationName } from "./stations";

/** Where a board's data came from — drives the UI provenance badge. */
export type BoardSource = "ldbws" | "darwin" | "timetable";

/** One carriage in a train formation. */
export interface Coach {
  number: string;
  first: boolean;
  /** Loading percentage (0-100) when the operator reports it. */
  loading?: number;
}

/** A single row on a live departure board. */
export interface BoardDeparture {
  tripId?: string;
  /** Darwin run id, once the live overlay has matched this trip. */
  rid?: string;
  destinationName: string;
  destinationCrs?: string;
  operator?: string;
  scheduled: string;
  /** Live estimated departure when Darwin has one. */
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
}

export type BoardOutcome =
  | { ok: true; board: BoardResult }
  | { ok: false; reason: "engine-offline" | "bad-request" | "unknown-station" };

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

export async function getBoard(
  crsInput: string,
  when?: string,
  limit = 20,
  callingAt?: string,
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
    const ldbws = await fetchLdbwsBoard(crs, limit, filterCrs);
    // With a filter, an empty result is authoritative ("nothing calls there") —
    // don't fall through to the unfiltered MOTIS board. Without a filter, an
    // empty LDBWS result means fall back.
    if (ldbws && (ldbws.departures.length > 0 || filterCrs)) {
      for (const d of ldbws.departures) {
        if (!d.destinationName && d.destinationCrs) {
          d.destinationName = await stationName(d.destinationCrs);
        }
      }
      // Fill coach formation from Darwin where LDBWS didn't provide it, then
      // overlay the live Network Rail running position (where the train is now).
      const withFormation = await enrichBoardWithFormation(crs, ldbws.departures);
      const departures = await enrichBoardWithPosition(crs, withFormation);
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
        },
      };
    }
  }

  // Fallback: MOTIS scheduled board, overlaid with any Darwin DB forecasts.
  const engine = createEngine();
  let raw: RawDeparture[];
  try {
    raw = await engine.departures({ stopId: crs, when, limit });
  } catch {
    return { ok: false, reason: "engine-offline" };
  }

  const scheduled = raw.map(scheduledRow);
  const { departures, live } = await enrichBoardWithDarwin(crs, scheduled);

  for (const d of departures) {
    if (!d.destinationName && d.destinationCrs) {
      d.destinationName = await stationName(d.destinationCrs);
    }
  }

  return {
    ok: true,
    board: {
      crs,
      stationName: name,
      generatedAt: new Date().toISOString(),
      live,
      source: live ? "darwin" : "timetable",
      messages: [],
      disruptions: await disruptionsPromise,
      departures,
    },
  };
}
