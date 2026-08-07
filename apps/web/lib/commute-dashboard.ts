import {
  type ActiveLeg,
  type CommuteRecord,
  dayOfWeekForDate,
  londonDate,
  londonWallTimeToIso,
  pickDefaultCommute,
  resolveActiveLegForCommute,
} from "@signaller/shared";
import { listCommutes } from "./commutes";
import { type Disruption as BoardDisruption, fetchStationDisruptions } from "./disruptions";
import { holidayRangesFor } from "./holidays";
import { planJourneys, type JourneyView } from "./journeys";

/** Other commutes the user has, for a switcher UI — excludes the one in play. */
export interface OtherCommute {
  id: string;
  label: string;
}

export type DashboardState =
  | {
      kind: "active";
      commuteId: string;
      commuteLabel: string;
      leg: ActiveLeg;
      journeys: JourneyView[];
      /** Station-level active disruptions for the origin. */
      disruptions: BoardDisruption[];
      /** True when the routing engine couldn't be reached. */
      engineOffline: boolean;
      otherCommutes: OtherCommute[];
    }
  | {
      kind: "no-active";
      commuteId: string;
      commuteLabel: string;
      reason: "rest-of-day" | "holiday" | "no-leg-today";
      otherCommutes: OtherCommute[];
    }
  | { kind: "no-commute" };

/**
 * Resolves the single commute leg in play right now and fetches the next real
 * journeys along it. Journeys come from planJourneys() because it knows a train
 * actually calls at the destination — the departure board only exposes each
 * train's final destination. Live disruption context comes straight from the
 * disruptions API.
 *
 * `commuteId` picks a specific commute (from the switcher); when omitted, the
 * highest-priority commute with an active/relevant leg today is used — see
 * `pickDefaultCommute`. `shiftMinutes` offsets the query time for a same-day
 * "running late / leaving early" nudge — it never touches the saved schedule.
 */
export async function getDashboardData(
  userId: string,
  now = new Date(),
  commuteId?: string,
  shiftMinutes = 0,
): Promise<DashboardState> {
  const commutes = await listCommutes(userId);
  if (commutes.length === 0) return { kind: "no-commute" };

  const holidays = await holidayRangesFor(userId);

  const commute =
    (commuteId ? commutes.find((c) => c.id === commuteId) : null) ??
    pickDefaultCommute(commutes, holidays, now);
  if (!commute) return { kind: "no-commute" };

  const otherCommutes = commutes.filter((c) => c.id !== commute.id).map((c) => ({ id: c.id, label: c.label }));

  const record: CommuteRecord = {
    id: commute.id,
    label: commute.label,
    homeCrs: commute.homeCrs,
    homeLabel: commute.homeLabel,
    priority: commute.priority,
  };
  const leg = resolveActiveLegForCommute(record, commute.legs, holidays, now);

  if (!leg) {
    const today = londonDate(now);
    const isHoliday = holidays.some((r) => today >= r.startDate && today <= r.endDate);
    const dow = dayOfWeekForDate(today);
    const hasLegToday = commute.legs.some((l) => l.dayOfWeek === dow);
    return {
      kind: "no-active",
      commuteId: commute.id,
      commuteLabel: commute.label,
      reason: isHoliday ? "holiday" : hasLegToday ? "rest-of-day" : "no-leg-today",
      otherCommutes,
    };
  }

  // Seed the plan at the window start (or now, if we're already inside it),
  // then apply the daily-flex shift on top.
  const today = londonDate(now);
  const windowStartIso = londonWallTimeToIso(today, leg.windowStart);
  const base = Date.parse(windowStartIso) > now.getTime() ? windowStartIso : now.toISOString();
  const when = new Date(Date.parse(base) + shiftMinutes * 60_000).toISOString();

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
    commuteId: commute.id,
    commuteLabel: commute.label,
    leg,
    journeys,
    disruptions,
    engineOffline,
    otherCommutes,
  };
}
