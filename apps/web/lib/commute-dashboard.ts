import {
  type ActiveLeg,
  type CommuteRecord,
  dayOfWeekForDate,
  londonDate,
  londonWallTimeToIso,
  resolveActiveLeg,
} from "@mainline/shared";
import { listCommutes } from "./commutes";
import { type Disruption as BoardDisruption, fetchStationDisruptions } from "./disruptions";
import { holidayRangesFor } from "./holidays";
import { planJourneys, type JourneyView } from "./journeys";

export type DashboardState =
  | {
      kind: "active";
      commuteLabel: string;
      leg: ActiveLeg;
      journeys: JourneyView[];
      /** Station-level active disruptions for the origin. */
      disruptions: BoardDisruption[];
      /** True when the routing engine couldn't be reached. */
      engineOffline: boolean;
    }
  | { kind: "no-active"; commuteLabel: string; reason: "rest-of-day" | "holiday" | "no-leg-today" }
  | { kind: "no-commute" };

/**
 * Resolves the single commute leg in play right now and fetches the next real
 * journeys along it. Journeys come from planJourneys() because it knows a train
 * actually calls at the destination — the departure board only exposes each
 * train's final destination. Live disruption context comes straight from the
 * disruptions API.
 */
export async function getDashboardData(deviceId: string, now = new Date()): Promise<DashboardState> {
  const commutes = await listCommutes(deviceId);
  if (commutes.length === 0) return { kind: "no-commute" };

  // v1: focus on the first commute. (Multiple commutes can be surfaced later.)
  const commute = commutes[0]!;
  const holidays = await holidayRangesFor(deviceId);

  const record: CommuteRecord = {
    id: commute.id,
    label: commute.label,
    homeCrs: commute.homeCrs,
    homeLabel: commute.homeLabel,
  };
  const leg = resolveActiveLeg(record, commute.legs, holidays, now);

  if (!leg) {
    const today = londonDate(now);
    const isHoliday = holidays.some((r) => today >= r.startDate && today <= r.endDate);
    const dow = dayOfWeekForDate(today);
    const hasLegToday = commute.legs.some((l) => l.dayOfWeek === dow);
    return {
      kind: "no-active",
      commuteLabel: commute.label,
      reason: isHoliday ? "holiday" : hasLegToday ? "rest-of-day" : "no-leg-today",
    };
  }

  // Seed the plan at the window start (or now, if we're already inside it).
  const today = londonDate(now);
  const windowStartIso = londonWallTimeToIso(today, leg.windowStart);
  const when = Date.parse(windowStartIso) > now.getTime() ? windowStartIso : now.toISOString();

  const outcome = await planJourneys(leg.originCrs, leg.destCrs, when);
  const journeys = outcome.ok ? outcome.journeys : [];
  const engineOffline = !outcome.ok && outcome.reason === "engine-offline";

  // Origin-station disruptions (best-effort; never block the dashboard).
  //
  // Calls the disruptions API directly rather than going through getBoard().
  // getBoard() only produces this field by calling fetchStationDisruptions()
  // itself, so the result is identical — but the board pipeline also does an
  // LDBWS request, several forecast queries, a full RTPPM scan and the ordering
  // pass, all of which were thrown away. This page refreshes every 30 seconds
  // per user, so that was the most repeated waste in the app.
  let disruptions: BoardDisruption[] = [];
  try {
    disruptions = await fetchStationDisruptions(leg.originCrs);
  } catch {
    /* disruptions are supplementary */
  }

  return {
    kind: "active",
    commuteLabel: commute.label,
    leg,
    journeys,
    disruptions,
    engineOffline,
  };
}
