import {
  type ActiveLeg,
  dayOfWeekForDate,
  type CommuteLegRecord,
  type CommuteRecord,
  londonDate,
  londonWallTimeToIso,
  pickDefaultCommute,
  resolveActiveLegForCommute,
} from "@signaller/shared";
import { listCommutes } from "./commutes";
import { type Disruption as BoardDisruption, fetchStationDisruptions } from "./disruptions";
import { holidayRangesFor } from "./holidays";
import { planJourneys, type JourneyView } from "./journeys";
import { buildPinnedJourney } from "./pinned-journey";

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
      /** Set when this leg has pinned services but one no longer matches the
       *  timetable for today — journeys still falls back to a live search. */
      pinStaleNotice?: { headline: string };
    }
  | {
      kind: "no-active";
      commuteId: string;
      commuteLabel: string;
      reason: "rest-of-day" | "holiday" | "no-leg-today";
      otherCommutes: OtherCommute[];
      /** Home/work stations for the quick "go home" / "go to work" actions —
       *  from today's leg if one exists, otherwise the nearest day (forward,
       *  then back) that has one. Absent only if the commute has no legs at all. */
      quickStart?: { homeCrs: string; homeLabel: string; workCrs: string; workLabel: string };
    }
  | { kind: "no-commute" };

/**
 * The work station to offer for ad-hoc "go to work" / "go home" quick actions
 * when nothing is scheduled right now — today's leg if the commute has one,
 * otherwise the nearest day-of-week that does (checking forward first, e.g.
 * Saturday looks at Monday before Friday, since that's the next time the
 * commute actually runs).
 */
function nearestLegForQuickStart(legs: CommuteLegRecord[], todayDow: number): CommuteLegRecord | null {
  if (legs.length === 0) return null;
  for (let offset = 0; offset < 7; offset++) {
    const forward = legs.find((l) => l.dayOfWeek === (todayDow + offset) % 7);
    if (forward) return forward;
  }
  return null;
}

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

    const quickLeg = nearestLegForQuickStart(commute.legs, dow);
    const quickStart =
      quickLeg && commute.homeCrs
        ? {
            homeCrs: commute.homeCrs,
            homeLabel: commute.homeLabel ?? "Home",
            workCrs: quickLeg.workCrs,
            workLabel: quickLeg.workLabel,
          }
        : undefined;

    return {
      kind: "no-active",
      commuteId: commute.id,
      commuteLabel: commute.label,
      reason: isHoliday ? "holiday" : hasLegToday ? "rest-of-day" : "no-leg-today",
      otherCommutes,
      quickStart,
    };
  }

  // Seed the plan at the window start (or now, if we're already inside it),
  // then apply the daily-flex shift on top.
  const today = londonDate(now);
  const windowStartIso = londonWallTimeToIso(today, leg.windowStart);
  const base = Date.parse(windowStartIso) > now.getTime() ? windowStartIso : now.toISOString();
  const when = new Date(Date.parse(base) + shiftMinutes * 60_000).toISOString();

  let journeys: JourneyView[] = [];
  let engineOffline = false;
  let pinStaleNotice: { headline: string } | undefined;

  if (leg.pinnedLegs && leg.pinnedLegs.length > 0) {
    const pinnedOutcome = await buildPinnedJourney(leg.pinnedLegs, leg.dayOfWeek, today);
    if (pinnedOutcome.ok) {
      journeys = [pinnedOutcome.journey];
    } else {
      // Pin is stale or Darwin has no data for it yet — never silently drop
      // the user's plan without telling them; fall back to a live search for
      // today so the dashboard still has something useful to show.
      if (pinnedOutcome.reason === "pin-stale") {
        pinStaleNotice = {
          headline: `Your pinned ${leg.direction === "am" ? "morning" : "evening"} train no longer runs today — showing live alternatives instead.`,
        };
      }
      const fallback = await planJourneys(leg.originCrs, leg.destCrs, when);
      journeys = fallback.ok ? fallback.journeys : [];
      engineOffline = !fallback.ok && fallback.reason === "engine-offline";
    }
  } else {
    const outcome = await planJourneys(leg.originCrs, leg.destCrs, when);
    journeys = outcome.ok ? outcome.journeys : [];
    engineOffline = !outcome.ok && outcome.reason === "engine-offline";
  }

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
    pinStaleNotice,
  };
}
