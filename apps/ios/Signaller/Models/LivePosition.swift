import Foundation

/// A `position` event from `/api/live/service?rid=`.
///
/// The payload is `null` when the train isn't correlated to a live run — which
/// is routine, not a failure, so the model keeps that distinction rather than
/// treating absence as an error.
struct LivePosition: Decodable, Hashable {
    /// Where the train is, in words.
    let label: String?
    let latitude: Double?
    let longitude: Double?
    let latenessMinutes: Double?
    let reportedAgoSeconds: Double?
    let approaching: Bool?
    let stale: Bool?
    let lastStopName: String?
    let nextStopName: String?
    /// Best live arrival estimate at the destination.
    let estimatedArrival: Date?

    private enum CodingKeys: String, CodingKey {
        case label, latitude, longitude, latenessMinutes, reportedAgoSeconds
        case approaching, stale, lastStopName, nextStopName, estimatedArrival
        case lat, lon
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        // The feed uses lat/lon in some payloads and latitude/longitude in
        // others; accept either rather than silently losing the position.
        latitude = try c.decodeIfPresent(Double.self, forKey: .latitude)
            ?? c.decodeIfPresent(Double.self, forKey: .lat)
        longitude = try c.decodeIfPresent(Double.self, forKey: .longitude)
            ?? c.decodeIfPresent(Double.self, forKey: .lon)
        latenessMinutes = try c.decodeIfPresent(Double.self, forKey: .latenessMinutes)
        reportedAgoSeconds = try c.decodeIfPresent(Double.self, forKey: .reportedAgoSeconds)
        approaching = try c.decodeIfPresent(Bool.self, forKey: .approaching)
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale)
        lastStopName = try c.decodeIfPresent(String.self, forKey: .lastStopName)
        nextStopName = try c.decodeIfPresent(String.self, forKey: .nextStopName)
        estimatedArrival = try c.decodeIfPresent(Date.self, forKey: .estimatedArrival)
    }

    /// Status text for a Live Activity, honest about lateness either way.
    var statusText: String {
        guard let lateness = latenessMinutes else { return "Tracking" }
        let rounded = Int(lateness.rounded())
        if rounded > 0 { return "\(rounded) min late" }
        if rounded < 0 { return "\(abs(rounded)) min early" }
        return "On time"
    }
}
