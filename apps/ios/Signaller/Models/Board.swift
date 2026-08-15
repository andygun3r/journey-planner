import Foundation

/// Mirrors `BoardResult` / `BoardDeparture` in `apps/web/lib/board.ts`.
///
/// The previous client decoded a narrow subset and dropped `messages`,
/// `disruptions`, `arrivals`, `platformChanged`, `reason`, `coaches` and
/// `position` — which is most of what makes the web board useful. They're all
/// here now.

struct BoardResponse: Codable {
    let ok: Bool
    let board: Board?
    let reason: String?
}

struct Board: Codable, Hashable {
    let crs: String
    let stationName: String
    let generatedAt: Date
    /// True when the board carries real-time data (LDBWS, or Darwin overlay).
    let live: Bool
    let source: String
    /// When filtered, the name of the "calling at" station.
    let filterName: String?
    /// NRCC station messages. May contain HTML.
    let messages: [String]
    let disruptions: [Disruption]
    let departures: [Departure]
    let arrivals: [Departure]
}

struct Disruption: Codable, Hashable, Identifiable {
    var id: String { (title ?? "") + (summary ?? "") }
    let title: String?
    let summary: String?
    let url: String?
}

struct Departure: Codable, Identifiable, Hashable {
    /// The API gives no stable row id, so fall back through the identifiers it
    /// does provide.
    var id: String {
        rid ?? tripId ?? "\(scheduled.timeIntervalSince1970)-\(destinationName)"
    }

    let tripId: String?
    /// Darwin run id, once the live overlay has matched this trip.
    let rid: String?
    let originName: String?
    let originCrs: String?
    let destinationName: String
    let destinationCrs: String?
    let operatorName: String?
    let scheduled: Date
    /// Live estimate. An instant, not "HH:MM".
    let live: Date?
    let platform: String?
    let platformChanged: Bool
    let status: JourneyStatus
    let delayMinutes: Int?
    /// Human-readable cause, e.g. "delayed by a late running train in front".
    let reason: String?
    let coachCount: Int?
    let coaches: [Coach]?
    /// True once real-time data has been applied to this row.
    let hasLive: Bool
    let position: BoardPosition?
    /// Operator's rolling last-hour punctuality (RTPPM), 0-100.
    let operatorPunctuality: Double?
    /// True when live running moved this row out of its booked position. The
    /// board sorts by expected departure, so a delayed train drops down the
    /// list — this flag lets the UI say so rather than appear to shuffle.
    let movedFromSchedule: Bool?

    /// The time to show: live when present.
    var effectiveTime: Date { live ?? scheduled }

    /// True when live running moved the time enough to be worth showing both.
    var isRetimed: Bool {
        guard let live else { return false }
        return abs(live.timeIntervalSince(scheduled)) >= 60
    }

    private enum CodingKeys: String, CodingKey {
        case tripId, rid, originName, originCrs, destinationName, destinationCrs
        case scheduled, live, platform, platformChanged, status, delayMinutes
        case reason, coachCount, coaches, hasLive, position, operatorPunctuality
        case movedFromSchedule
        case operatorName = "operator"
    }

    /// A minimal stand-in built from a rid, for opening the service screen from
    /// somewhere that has no board row — a train tapped on the map. Only `rid`
    /// and the destination are known; the screen fetches the rest.
    static func placeholder(rid: String, destination: String) -> Departure {
        Departure(
            tripId: nil,
            rid: rid,
            originName: nil,
            originCrs: nil,
            destinationName: destination,
            destinationCrs: nil,
            operatorName: nil,
            scheduled: Date(),
            live: nil,
            platform: nil,
            platformChanged: false,
            status: .scheduled,
            delayMinutes: nil,
            reason: nil,
            coachCount: nil,
            coaches: nil,
            hasLive: true,
            position: nil,
            operatorPunctuality: nil,
            movedFromSchedule: nil
        )
    }
}

struct Coach: Codable, Hashable, Identifiable {
    /// Stable for the life of the value.
    ///
    /// This was `number ?? UUID().uuidString` — a *computed* property, so an
    /// unnumbered coach minted a fresh id on every access. In a `ForEach` that
    /// destroys and rebuilds the row every render. Not reachable today (the
    /// formation strip renders `ServiceCoach`), but a trap for the next caller.
    let id: String
    let number: String?
    let coachClass: String?
    let toilet: String?
    /// Live loading as a percentage, when the operator reports it.
    let loading: Int?

    private enum CodingKeys: String, CodingKey {
        case number, toilet, loading
        case coachClass = "class"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        number = try container.decodeIfPresent(String.self, forKey: .number)
        coachClass = try container.decodeIfPresent(String.self, forKey: .coachClass)
        toilet = try container.decodeIfPresent(String.self, forKey: .toilet)
        loading = try container.decodeIfPresent(Int.self, forKey: .loading)
        // Assigned once at decode. An unnumbered coach still gets a stable id
        // for the lifetime of the value, which is what `ForEach` needs.
        id = number ?? UUID().uuidString
    }
}

/// Live "where is it right now", from the Network Rail overlay.
struct BoardPosition: Codable, Hashable {
    let label: String
    /// Minutes late (+) / early (−) at the last report.
    let latenessMinutes: Double?
    /// How long ago Network Rail last reported it.
    let reportedAgoSeconds: Double?
    /// True while the train hasn't left its origin yet.
    let approaching: Bool
    /// True when the last report is old enough that the train may have moved
    /// on. The row is still shown — a quiet feed isn't a vanished train — but
    /// the UI must say the age out loud rather than imply this is current.
    let stale: Bool?
}
