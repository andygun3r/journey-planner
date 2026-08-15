import Foundation

/// Mirrors `DashboardState` in `apps/web/lib/commute-dashboard.ts`.
///
/// A discriminated union on `kind`, so the three cases stay distinct in Swift
/// too: there's a leg running now, there's a commute but nothing scheduled, or
/// there's no commute at all. Collapsing them would lose the *reason* nothing
/// is showing, which is the most useful thing on the screen when it's empty.
struct DashboardResponse: Decodable {
    let ok: Bool
    let state: DashboardState
}

enum DashboardState: Decodable {
    case active(ActiveDashboard)
    case noActive(NoActiveDashboard)
    case noCommute

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
        switch kind {
        case "active":
            self = .active(try ActiveDashboard(from: decoder))
        case "no-active":
            self = .noActive(try NoActiveDashboard(from: decoder))
        default:
            self = .noCommute
        }
    }
}

struct ActiveDashboard: Decodable {
    let commuteId: String
    let commuteLabel: String
    let leg: ActiveLeg
    let journeys: [Journey]
    let disruptions: [Disruption]
    /// True when the routing engine couldn't be reached — the journeys list is
    /// empty for a reason the user should be told about.
    let engineOffline: Bool
    let otherCommutes: [OtherCommute]
    /// Set when a pinned service no longer matches today's timetable.
    let pinStaleNotice: PinStaleNotice?
    /// Present while the user has explicitly started this commute, which locks
    /// the direction so the dashboard can't flip underneath them mid-journey.
    let run: CommuteRun?
}

struct PinStaleNotice: Decodable {
    let headline: String
}

struct NoActiveDashboard: Decodable {
    let commuteId: String
    let commuteLabel: String
    /// Why nothing is scheduled: rest-of-day, holiday, no-leg-today, skipped.
    let reason: String
    let otherCommutes: [OtherCommute]
    /// Stations for the ad-hoc "go to work" / "go home" buttons.
    let quickStart: QuickStart?

    /// Plain-English version of `reason`.
    var explanation: String {
        switch reason {
        case "rest-of-day": return "Nothing left on this commute today."
        case "holiday": return "You're on holiday — alerts are paused."
        case "no-leg-today": return "This commute doesn't run today."
        case "skipped": return "You marked today as skipped."
        default: return "Nothing scheduled right now."
        }
    }
}

struct QuickStart: Decodable {
    let homeCrs: String
    let homeLabel: String
    let workCrs: String
    let workLabel: String
}

struct OtherCommute: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
}

struct ActiveLeg: Decodable {
    let legId: String?
    let dayOfWeek: Int
    /// "am" or "pm".
    let direction: String
    let originCrs: String
    let originLabel: String
    let destCrs: String
    let destLabel: String
    /// "HH:MM" travel window.
    let windowStart: String?
    let windowEnd: String?
    /// True when the window is still ahead rather than already running.
    let upcoming: Bool
    let pinnedLegs: [PinnedLeg]

    var directionLabel: String { direction == "am" ? "To work" : "Home" }
}

struct PinnedLeg: Decodable, Identifiable, Hashable {
    let id: String
    let direction: String
    let sequence: Int
    let trainUid: String?
    let gtfsTripId: String?
    let originCrs: String
    let originLabel: String?
    let destCrs: String
    let destLabel: String?
    /// "HH:MM" booked times.
    let schedDep: String?
    let schedArr: String?
    let toc: String?
}

/// A started commute — see the `commute_run` table for why the dashboard can't
/// simply re-resolve the schedule once someone is travelling.
struct CommuteRun: Decodable, Hashable {
    let id: String
    let commuteId: String
    let commuteLegId: String?
    let serviceDate: String
    let direction: String
    let originCrs: String
    let originLabel: String
    let destCrs: String
    let destLabel: String
    let scheduledArrival: Date?
    let startedAt: Date?
}

/// A commute, as returned by `GET /api/commute`.
struct CommuteSummary: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let homeCrs: String
    let homeLabel: String
    let priority: Int?
    let legs: [CommuteLeg]
}

struct CommuteLeg: Decodable, Identifiable, Hashable {
    let id: String?
    /// 0 = Monday … 6 = Sunday.
    let dayOfWeek: Int
    let workCrs: String
    let workLabel: String
    let am: CommuteWindow?
    let pm: CommuteWindow?

    var dayName: String {
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            .indices.contains(dayOfWeek)
            ? ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][dayOfWeek]
            : "Day \(dayOfWeek)"
    }
}

struct CommuteWindow: Decodable, Hashable {
    let start: String?
    let end: String?

    var label: String? {
        guard let start, let end else { return nil }
        return "\(start)–\(end)"
    }
}

struct CommuteListResponse: Decodable {
    let ok: Bool
    let commutes: [CommuteSummary]
}
