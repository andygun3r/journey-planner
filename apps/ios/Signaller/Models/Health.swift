import Foundation

/// `/api/health`. Returns HTTP 503 when a dependency is down, so the client
/// only sees this decoded on a 2xx; a degraded backend surfaces as
/// `APIError.http` instead.
struct HealthResponse: Codable, Hashable {
    let ok: Bool
    let postgres: Bool
    let redis: Bool
    let schema: Bool?
    /// An object, not a boolean — it carries when the last timetable load
    /// succeeded and whether it has gone stale.
    let timetable: TimetableHealth?
    let service: String?
}

struct TimetableHealth: Codable, Hashable {
    let ok: Bool?
    let stale: Bool?
    let hoursSinceSuccess: Double?
    let lastSuccessVersion: String?
    let lastAttemptFailed: Bool?
    let lastFailureDetail: String?

    /// What to show next to "Timetable" on the status screen.
    var summary: String? {
        guard let hours = hoursSinceSuccess else { return lastSuccessVersion }
        if hours < 1 { return "updated under an hour ago" }
        if hours < 48 { return "updated \(Int(hours.rounded()))h ago" }
        return "updated \(Int((hours / 24).rounded())) days ago"
    }
}
