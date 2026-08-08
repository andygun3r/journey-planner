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
import { getOverride } from "./commute-overrides";
import { type CommuteRun, getActiveRun } from "./commute-runs";
import { type Disruption as BoardDisruption, fetchStationDisruptions } from "./disruptions";
import { holidayRangesFor } from "./holidays";
import { enrichJourneyLive } from "./journey-live";
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
      /**
       * Set while the user has explicitly started this commute. The leg above
       * then comes from the run, not from re-resolving the schedule, so the
       * dashboard can't switch direction underneath someone mid-journey.
       */
      run?: CommuteRun;
    }
  | {
      kind: "no-active";
      commuteId: string;
      commuteLabel: string;
      reason: "rest-of-day" | "holiday" | "no-leg-today" | "skipped";
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
 * Rebuilds the ActiveLeg a started run represents.
 *
 * The run stores its own origin/destination, so this holds even for an ad-hoc
 * run with no scheduled leg behind it. Where the run DOES point at a real leg,
 * that leg's pins and backup stations are carried across so the panel keeps
 * showing the pinned service and its fallbacks.
 *
 * The window is deliberately widened to the whole day: the run is the thing
 * keeping this leg on screen, not the clock, and a window that ends while the
 * user is still travelling is exactly the bug this feature fixes.
 */
function legFromRun(run: CommuteRun, legs: CommuteLegRecord[]): ActiveLeg {
  const leg = run.commuteLegId ? legs.find((l) => l.id === run.commuteLegId) : undefined;
  const pins = leg?.pins
    .filter((p) => p.direction === run.direction)
    .sort((a, b) => a.sequence - b.sequence);

  return {
    legId: leg?.id ?? run.id,
    dayOfWeek: leg?.dayOfWeek ?? dayOfWeekForDate(run.serviceDate),
    direction: run.direction,
    originCrs: run.originCrs,
    originLabel: run.originLabel,
    destCrs: run.destCrs,
    destLabel: run.destLabel,
    windowStart: "00:00",
    windowEnd: "23:59",
    // A run is by definition already under way — never "upcoming".
    upcoming: false,
    backupOriginCrs:
      (run.direction === "am" ? leg?.backupHomeCrs : leg?.backupWorkCrs) ?? undefined,
    backupDestCrs:
      (run.direction === "am" ? leg?.backupWorkCrs : leg?.backupHomeCrs) ?? undefined,
    backupNote: leg?.backupNote ?? undefined,
    pinnedLegs: pins && pins.length > 0 ? pins : undefined,
  };
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
  // A started run wins over schedule resolution. resolveActiveLegForCommute
  // answers "what does the timetable say is happening now", which flips from
  // AM to PM the instant the morning window ends — fine for an idle dashboard,
  // wrong for someone sitting on the 08:12. getActiveRun also auto-ends the run
  // once its arrival time passes, so this reverts to normal resolution by
  // itself with nothing to clean up.
  const run = await getActiveRun(userId, commute.id, now);

  // Today's single-date exception, if the user set one in the calendar.
  const todayOverride = await getOverride(userId, commute.id, londonDate(now)).catch(() => null);

  const leg = run
    ? legFromRun(run, commute.legs)
    : resolveActiveLegForCommute(record, commute.legs, holidays, now, todayOverride);

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
      // A skipped date is a deliberate "not travelling today", so say that
      // rather than the misleading "you're done for today".
      reason: todayOverride?.skipped
        ? "skipped"
        : isHoliday
          ? "holiday"
          : hasLegToday
            ? "rest-of-day"
            : "no-leg-today",
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

  if (run?.journey) {
    // The user started a specific train. Keep showing that one — re-planning
    // here would quietly swap them onto a "better" service they aren't on.
    // Live status is still refreshed below via enrichJourneyLive.
    journeys = [run.journey];
  } else if (leg.pinnedLegs && leg.pinnedLegs.length > 0) {
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

  // Live-enrich only the primary journey — the one the leg cards actually
  // render. The board query this does is a real network+DB round trip per
  // origin station, so there's no point paying it for backup options nobody
  // is looking at yet (BackupRoutes enriches its own results on demand).
  if (journeys[0]) {
    try {
      journeys[0] = await enrichJourneyLive(journeys[0]);
    } catch {
      /* live enrichment is best-effort; the plain plan still works */
    }
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
    run: run ?? undefined,
  };
}
