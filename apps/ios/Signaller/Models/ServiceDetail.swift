import Foundation

/// Mirrors `ServiceDetails` in `apps/web/lib/service-details.ts`.
///
/// Careful with times here: this type carries **both** display strings
/// (`scheduled` = "HH:MM", `expected` = "On time" / "Delayed" / "HH:MM") and
/// real instants (the `*Iso` fields). Only the `*Iso` ones are dates. Keep the
/// display strings as `String` — `expected` is often not a time at all, so
/// decoding it as a `Date` would throw on perfectly valid data.

struct ServiceResponse: Codable {
    let ok: Bool
    let service: ServiceDetail?
    let reason: String?
}

struct ServiceDetail: Codable, Hashable {
    let stationName: String
    let crs: String
    let operatorName: String?
    let operatorCode: String?
    let platform: String?
    /// "HH:MM", not an instant.
    let scheduledDeparture: String?
    /// "On time", "HH:MM", "Delayed" or "Cancelled" — display text.
    let expectedDeparture: String?
    let cancelled: Bool
    let cancelReason: String?
    let delayReason: String?
    let coaches: [ServiceCoach]
    let length: Int?
    /// The linear route of the portion you're travelling on.
    let calls: [ServiceCall]
    /// Associated portions when the service divides or joins. Usually empty.
    let portions: [ServicePortion]
    let progress: ServiceProgress
    /// Darwin run id, once resolved. Powers live position and the SSE stream.
    let rid: String?

    private enum CodingKeys: String, CodingKey {
        case stationName, crs, operatorCode, platform, scheduledDeparture
        case expectedDeparture, cancelled, cancelReason, delayReason, coaches
        case length, calls, portions, progress, rid
        case operatorName = "operator"
    }
}

struct ServiceCoach: Codable, Hashable, Identifiable {
    var id: String { number }
    let number: String
    let first: Bool
    let coachClass: String?
    /// Live loading percentage, when the operator reports it.
    let loading: Int?
    let toilet: String?
}

/// Where a stop sits relative to the train's live progress.
enum CallProgress: String, Codable, Hashable {
    case departed, current, upcoming, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CallProgress(rawValue: raw) ?? .unknown
    }
}

struct ServiceCall: Codable, Hashable, Identifiable {
    var id: String { (crs ?? name) + (scheduled ?? "") }

    let crs: String?
    let name: String
    /// "HH:MM" for display.
    let scheduled: String?
    /// The scheduled time as a real instant.
    let scheduledIso: Date?
    /// Live text: "On time", "HH:MM", "Delayed", "Cancelled".
    let expected: String?
    /// The estimate as an instant, when `expected` is an actual time.
    let expectedIso: Date?
    let platform: String?
    let cancelled: Bool
    /// True for the "you are here" origin stop.
    let isThisStop: Bool?
    let progress: CallProgress?
    /// Actual reported time here ("HH:MM"), once the train has passed.
    let actual: String?
    let actualIso: Date?
    /// Best live arrival estimate — drives the countdown.
    let estimatedArrivalIso: Date?
}

struct ServicePortion: Codable, Hashable, Identifiable {
    var id: String { kind + (terminusName ?? "") }
    /// `divides`: an onward portion. `joins`: one that merges into this.
    let kind: String
    let terminusName: String?
    let cancelled: Bool
    /// LDBWS says passengers must change carriages to stay with this portion.
    let changeRequired: Bool
    let calls: [ServiceCall]
}

/// Why the page is (or isn't) showing a live position.
///
/// `awaitingReport` is the important one: it separates "running but nothing has
/// reported yet" from "we couldn't identify this train at all". Correlation is
/// strict, so absence is routine and has to read as honest, not broken.
enum PositionState: String, Codable, Hashable {
    case tracked
    case awaitingReport = "awaiting-report"
    case notTracked = "not-tracked"

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PositionState(rawValue: raw) ?? .notTracked
    }
}

struct ServiceProgress: Codable, Hashable {
    /// True when we resolved this service to a live Darwin train run.
    let tracking: Bool
    let positionState: PositionState
    let lastStopName: String?
    let nextStopName: String?
    let delayMinutes: Int?
    let arrived: Bool
    // Network Rail positioning — finer than Darwin's station-level view.
    let networkRail: Bool
    let nrLastLocation: String?
    let nrLastEvent: String?
    let nrReportedAgoSeconds: Double?
    let nrLatenessMinutes: Double?
}
