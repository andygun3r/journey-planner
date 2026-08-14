import Foundation

/// Mirrors `JourneyView` / `JourneyLegView` in `apps/web/lib/journeys.ts`.

struct JourneyResponse: Decodable {
    let ok: Bool
    let journeys: [Journey]?
    let reason: String?
}

struct Journey: Decodable, Identifiable, Hashable {
    let id: String
    let departs: Date
    let arrives: Date
    let liveDeparts: Date?
    let liveArrives: Date?
    let durationMinutes: Int
    let changes: Int
    let status: JourneyStatus
    let delayMinutes: Int?
    let legs: [JourneyLeg]
    /// Set when a geocoded destination fell back to "nearest station" —
    /// e.g. "≈750m from Victoria".
    let destinationWalkNote: String?

    /// The time to actually show for departure: live when we have it.
    var effectiveDeparture: Date { liveDeparts ?? departs }
    var effectiveArrival: Date { liveArrives ?? arrives }

    /// True when live data moved the departure away from the timetable, which
    /// is what justifies showing the scheduled time struck through.
    var departureIsRetimed: Bool {
        guard let liveDeparts else { return false }
        return abs(liveDeparts.timeIntervalSince(departs)) >= 60
    }
}

/// `status` is a closed set server-side. Decoding it as an enum with an
/// `unknown` fallback means a new backend value degrades to "scheduled"
/// instead of failing the whole response.
enum JourneyStatus: String, Decodable, Hashable {
    case onTime = "on-time"
    case delayed
    case cancelled
    case scheduled
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = JourneyStatus(rawValue: raw) ?? .unknown
    }
}

struct JourneyLeg: Decodable, Identifiable, Hashable {
    /// Composite: the API doesn't give legs their own ids, and origin+dest+time
    /// is unique within a journey.
    var id: String { "\(originCrs)-\(destCrs)-\(departs.timeIntervalSince1970)" }

    let mode: String
    let originName: String
    /// CRS for a rail leg, NaPTAN id for a TfL leg.
    let originCrs: String
    let destName: String
    let destCrs: String
    let departs: Date
    let arrives: Date
    let operatorName: String?
    let lineId: String?
    let lineName: String?
    let staySeated: Bool
    let cancelled: Bool
    let callCount: Int
    let nextCallName: String?
    let originLat: Double?
    let originLon: Double?
    let destLat: Double?
    let destLon: Double?
    /// Metres on foot — set for walk legs once street routing is enabled.
    let distanceMeters: Double?
    let durationSeconds: Double?

    var isWalk: Bool { mode == "walk" }
    var isRail: Bool { mode == "rail" }

    /// What to call this leg in the UI: the line for TfL, the operator for
    /// rail, and nothing for a walk (the icon carries it).
    var modeLabel: String? {
        if isWalk { return nil }
        return lineName ?? operatorName
    }

    private enum CodingKeys: String, CodingKey {
        case mode, originName, originCrs, destName, destCrs, departs, arrives
        case lineId, lineName, staySeated, cancelled, callCount, nextCallName
        case originLat, originLon, destLat, destLon, distanceMeters, durationSeconds
        // `operator` is a Swift keyword.
        case operatorName = "operator"
    }
}
