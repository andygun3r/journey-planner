import Foundation

/// `/api/health`. Returns HTTP 503 when a dependency is down, so the client
/// only sees this decoded on a 2xx; a degraded backend surfaces as
/// `APIError.http` instead.
struct HealthResponse: Decodable, Hashable {
    let ok: Bool
    let postgres: Bool
    let redis: Bool
    let schema: Bool?
    let timetable: Bool?
    let service: String?
}
