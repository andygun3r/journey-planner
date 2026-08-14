import Foundation

struct JourneyResponse: Decodable {
    let ok: Bool
    let journeys: [Journey]?
    let reason: String?
}

struct Journey: Decodable, Identifiable {
    let id: String
    let departs: String
    let arrives: String
    let liveDeparts: String?
    let liveArrives: String?
    let durationMinutes: Int
    let changes: Int
    let status: String
    let delayMinutes: Int?
    let legs: [JourneyLeg]
}

struct JourneyLeg: Decodable, Identifiable {
    var id: String { "\(originCrs)-\(destCrs)-\(departs)" }
    let mode: String
    let originName: String
    let originCrs: String
    let destName: String
    let destCrs: String
    let departs: String
    let arrives: String
    let operatorName: String?
    let lineName: String?
    let cancelled: Bool
    let callCount: Int

    private enum CodingKeys: String, CodingKey {
        case mode, originName, originCrs, destName, destCrs, departs, arrives, lineName, cancelled, callCount
        case operatorName = "operator"
    }
}

struct BoardResponse: Decodable {
    let ok: Bool
    let board: Board?
    let reason: String?
}

struct Board: Decodable {
    let crs: String
    let stationName: String
    let generatedAt: String
    let live: Bool
    let source: String
    let departures: [Departure]
}

struct Departure: Decodable, Identifiable {
    var id: String { rid ?? tripId ?? "\(scheduled)-\(destinationName)" }
    let tripId: String?
    let rid: String?
    let destinationName: String
    let operatorName: String?
    let scheduled: String
    let live: String?
    let platform: String?
    let status: String
    let delayMinutes: Int?
    let hasLive: Bool

    private enum CodingKeys: String, CodingKey {
        case tripId, rid, destinationName, scheduled, live, platform, status, delayMinutes, hasLive
        case operatorName = "operator"
    }
}

struct HealthResponse: Decodable {
    let ok: Bool
    let postgres: Bool
    let redis: Bool
    let schema: Bool?
    let service: String
}

enum APIError: Error, LocalizedError {
    case badURL
    case badResponse

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "The backend URL is invalid."
        case .badResponse:
            return "The backend returned an unexpected response."
        }
    }
}

final class APIClient {
    static let shared = APIClient()

    let baseURL: URL
    private let decoder = JSONDecoder()

    private init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "SIGNALLER_API_BASE_URL") as? String
        let raw = configured?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = "http://localhost:3000"
        baseURL = URL(string: raw?.isEmpty == false ? raw! : fallback) ?? URL(string: fallback)!
    }

    func plan(from: String, to: String) async throws -> JourneyResponse {
        var components = try components(path: "/api/journeys")
        components.queryItems = [
            URLQueryItem(name: "from", value: from.trimmingCharacters(in: .whitespacesAndNewlines)),
            URLQueryItem(name: "to", value: to.trimmingCharacters(in: .whitespacesAndNewlines))
        ]
        return try await get(components)
    }

    func board(crs: String) async throws -> BoardResponse {
        let clean = crs.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return try await get(components(path: "/api/boards/\(clean)?limit=8"))
    }

    func health() async throws -> HealthResponse {
        try await get(components(path: "/api/health"))
    }

    private func components(path: String) throws -> URLComponents {
        guard let url = URL(string: path, relativeTo: baseURL), let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
            throw APIError.badURL
        }
        return components
    }

    private func get<T: Decodable>(_ components: URLComponents) async throws -> T {
        guard let url = components.url else { throw APIError.badURL }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...599).contains(http.statusCode) else {
            throw APIError.badResponse
        }
        return try decoder.decode(T.self, from: data)
    }
}

func timeLabel(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "--:--" }
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) {
        return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }
    return String(value.prefix(5))
}
