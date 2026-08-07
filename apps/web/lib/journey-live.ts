import { getBoard, type BoardDeparture, type BoardSource } from "./board";
import { ridServiceId } from "./service-details";
import { ukHhmm } from "./uk-time";
import type { JourneyLegView, JourneyView } from "./journeys";

/**
 * Live running detail for one rail leg of a commute journey — the platform,
 * where the train physically is, and whether it's cancelled/delayed. Powers
 * the leg cards on the dashboard (see CommuteLegCards): each card is "one
 * train," so it needs the same live picture the departure board already
 * resolves, not just the routing engine's static plan.
 */
export interface LegLiveView {
  /** Darwin run id, once matched — links the card to /services/[id]. */
  rid?: string;
  /**
   * The id + query string to link to /services/[id] with, already in the
   * shape the page expects (e.g. "744311ADLESTN_?from=ASN"). Built the same
   * way boards/[crs]/page.tsx's serviceHref does: the LDBWS trip id when the
   * board came from LDBWS — richer (real calling pattern, formation) than
   * the rid: fallback — else the Darwin rid.
   */
  serviceHref?: string;
  platform?: string;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  /** "Passed Hatfield, 2 late" style summary from the NR position overlay. */
  positionLabel?: string;
  approaching: boolean;
}

export type LiveJourneyLeg = JourneyLegView & { live?: LegLiveView };
export type LiveJourneyView = Omit<JourneyView, "legs"> & { legs: LiveJourneyLeg[] };

/**
 * Same precedence boards/[crs]/page.tsx's serviceHref uses: prefer the
 * LDBWS trip id (only meaningful when the board that produced this row was
 * itself LDBWS-sourced) over the Darwin rid, since it resolves to the
 * fuller Service Details view rather than the rid-only fallback.
 */
function toServiceHref(row: BoardDeparture, source: BoardSource, originCrs: string): string | undefined {
  const serviceId = row.tripId && source === "ldbws" ? row.tripId : row.rid ? ridServiceId(row.rid) : undefined;
  if (!serviceId) return undefined;
  return `${encodeURIComponent(serviceId)}?from=${originCrs}`;
}

function toLive(row: BoardDeparture, source: BoardSource, originCrs: string): LegLiveView {
  return {
    rid: row.rid,
    serviceHref: toServiceHref(row, source, originCrs),
    platform: row.platform,
    status: row.status,
    delayMinutes: row.delayMinutes,
    positionLabel: row.position?.label,
    approaching: row.position?.approaching ?? false,
  };
}

/**
 * Matches a rail leg to its departure-board row by scheduled minute +
 * destination — the same disambiguation board-position.ts uses, since a
 * shared minute at a busy station cannot otherwise identify a single train.
 */
function findRow(rows: BoardDeparture[], leg: JourneyLegView): BoardDeparture | undefined {
  const minute = ukHhmm(leg.departs);
  if (!minute) return undefined;
  const candidates = rows.filter((r) => ukHhmm(r.scheduled) === minute);
  if (candidates.length === 1) return candidates[0];
  return candidates.find((r) => r.destinationCrs === leg.destCrs) ?? undefined;
}

/**
 * Enriches every rail leg of a journey with live board data (platform,
 * position, cancellation) by querying each leg's origin board once. Best
 * effort throughout — a station whose board can't be reached just leaves
 * that leg's `live` unset rather than failing the whole journey.
 */
export async function enrichJourneyLive(journey: JourneyView): Promise<LiveJourneyView> {
  const railLegOrigins = [...new Set(journey.legs.filter((l) => l.mode === "rail").map((l) => l.originCrs))];

  const boards = new Map<string, { rows: BoardDeparture[]; source: BoardSource }>();
  await Promise.all(
    railLegOrigins.map(async (crs) => {
      try {
        const outcome = await getBoard(crs, undefined, 40);
        if (outcome.ok) boards.set(crs, { rows: outcome.board.departures, source: outcome.board.source });
      } catch {
        /* live enrichment is best-effort */
      }
    }),
  );

  const legs: LiveJourneyLeg[] = journey.legs.map((leg) => {
    if (leg.mode !== "rail") return leg;
    const board = boards.get(leg.originCrs);
    if (!board) return leg;
    const row = findRow(board.rows, leg);
    if (!row) return leg;
    return { ...leg, live: toLive(row, board.source, leg.originCrs) };
  });

  return { ...journey, legs };
}
