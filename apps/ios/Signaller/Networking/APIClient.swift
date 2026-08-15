import Foundation

/// Talks to the Next.js app in `apps/web`.
///
/// One rule shapes the error handling here: the API distinguishes "I answered,
/// and the answer is no results" (HTTP 200 with `ok: false`) from "I couldn't
/// answer" (4xx/5xx). Both used to arrive as the same generic failure because
/// the status check accepted 200 through 599. They're separated now — see
/// `send(_:)`.
/// Main-actor isolated rather than `Sendable`: it reads the token from
/// `AuthStore`, which is `@Observable` main-actor state. Claiming `Sendable`
/// while holding it was a data race the compiler flagged — every caller is a
/// view or a view model on the main actor anyway, and the actual network I/O
/// still happens off it inside `URLSession`.
@MainActor
final class APIClient {
    nonisolated let baseURL: URL
    private let session: URLSession
    private let auth: AuthStore?

    init(baseURL: URL? = nil, auth: AuthStore? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL ?? Self.configuredBaseURL()
        self.auth = auth
        self.session = session
    }

    /// Reads `SIGNALLER_API_BASE_URL`, injected from the xcconfig at build time.
    ///
    /// A Release build can't reach here with a bad value — the "Check API base
    /// URL" build phase fails first — so the localhost fallback only ever
    /// applies to a misconfigured Debug build.
    nonisolated private static func configuredBaseURL() -> URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "SIGNALLER_API_BASE_URL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        assertionFailure("SIGNALLER_API_BASE_URL is missing or malformed: \(raw ?? "nil")")
        return URL(string: "http://localhost:3000")!
    }

    // MARK: - Endpoints

    /// Plans a journey. `from`/`to` are CRS codes, postcodes or `place:<uprn>`.
    /// Omitting `when` means "now", which is also what enables live enrichment
    /// server-side.
    func plan(from: String, to: String, when: Date? = nil) async throws -> JourneyResponse {
        var items = [
            URLQueryItem(name: "from", value: from.trimmingCharacters(in: .whitespacesAndNewlines)),
            URLQueryItem(name: "to", value: to.trimmingCharacters(in: .whitespacesAndNewlines)),
        ]
        if let when {
            items.append(URLQueryItem(name: "when", value: ISO8601.string(from: when)))
        }
        return try await get("/api/journeys", query: items)
    }

    /// Departure board for a station. `limit` is clamped 1...50 server-side;
    /// 20 matches the web app's default.
    func board(
        crs: String,
        limit: Int = 20,
        when: Date? = nil,
        callingAt: String? = nil
    ) async throws -> BoardResponse {
        let clean = crs.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let when {
            items.append(URLQueryItem(name: "when", value: ISO8601.string(from: when)))
        }
        if let callingAt, !callingAt.isEmpty {
            items.append(URLQueryItem(name: "callingAt", value: callingAt.uppercased()))
        }
        return try await get("/api/boards/\(clean)", query: items)
    }

    /// Station search. Returns stations and places as *separate* lists — see
    /// `StationSearchResponse` for why they must not be merged.
    func stations(query: String, includePlaces: Bool = true) async throws -> StationSearchResponse {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return StationSearchResponse(stations: [], places: []) }

        var items = [URLQueryItem(name: "q", value: trimmed)]
        if includePlaces { items.append(URLQueryItem(name: "places", value: "1")) }

        // Without `places=1` the route returns a bare array; with it, an object.
        // Ask for places and decode the object form.
        if includePlaces {
            return try await get("/api/stations", query: items)
        }
        let stations: [Station] = try await get("/api/stations", query: items)
        return StationSearchResponse(stations: stations, places: [])
    }

    func service(id: String) async throws -> ServiceResponse {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await get("/api/services/\(encoded)")
    }

    func health() async throws -> HealthResponse {
        try await get("/api/health")
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var request = URLRequest(url: try url(path: path, query: query))
        request.httpMethod = "GET"
        return try await send(request)
    }

    private func url(path: String, query: [URLQueryItem]) throws -> URL {
        guard let resolved = URL(string: path, relativeTo: baseURL),
              var components = URLComponents(url: resolved, resolvingAgainstBaseURL: true)
        else { throw APIError.badURL }

        // Query items go through URLComponents so values are percent-encoded.
        // The old client concatenated "?limit=8" into the path string, which
        // only worked because a CRS happens to need no encoding.
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.badURL }
        return url
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = auth?.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("The server sent a malformed response.")
        }

        if http.statusCode == 401 { throw APIError.unauthorized }

        guard (200..<300).contains(http.statusCode) else {
            // Failures carry `{ ok: false, reason }`, which is far more useful
            // than the status alone — but an error page (nginx, a Next.js HTML
            // 500) won't decode, so treat `reason` as best-effort.
            let envelope = try? JSONDecoder.signaller.decode(APIFailureEnvelope.self, from: data)
            throw APIError.http(status: http.statusCode, reason: envelope?.reason)
        }

        do {
            return try JSONDecoder.signaller.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}
