import { getBoard, type BoardDeparture } from "./board";
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
  serviceId?: string;
  platform?: string;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  /** "Passed Hatfield, 2 late" style summary from the NR position overlay. */
  positionLabel?: string;
  approaching: boolean;
}

export type LiveJourneyLeg = JourneyLegView & { live?: LegLiveView };
export type LiveJourneyView = Omit<JourneyView, "legs"> & { legs: LiveJourneyLeg[] };

function toLive(row: BoardDeparture): LegLiveView {
  return {
    rid: row.rid,
    serviceId: row.rid ? ridServiceId(row.rid) : undefined,
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

  const boards = new Map<string, BoardDeparture[]>();
  await Promise.all(
    railLegOrigins.map(async (crs) => {
      try {
        const outcome = await getBoard(crs, undefined, 40);
        if (outcome.ok) boards.set(crs, outcome.board.departures);
      } catch {
        /* live enrichment is best-effort */
      }
    }),
  );

  const legs: LiveJourneyLeg[] = journey.legs.map((leg) => {
    if (leg.mode !== "rail") return leg;
    const rows = boards.get(leg.originCrs);
    if (!rows) return leg;
    const row = findRow(rows, leg);
    if (!row) return leg;
    return { ...leg, live: toLive(row) };
  });

  return { ...journey, legs };
}
