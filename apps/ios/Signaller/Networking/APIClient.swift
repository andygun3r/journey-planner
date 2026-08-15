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

    /// The whole station list, for the on-device typeahead index.
    ///
    /// Without `?q=` the route returns every station — a contract its own
    /// comment calls "kept for callers that still embed it".
    func allStations() async throws -> [Station] {
        try await get("/api/stations")
    }

    func service(id: String) async throws -> ServiceResponse {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await get("/api/services/\(encoded)")
    }

    func health() async throws -> HealthResponse {
        try await get("/api/health")
    }

    /// One-shot poll of every tracked train. The SSE stream at
    /// `/api/live/trains` is the normal source; this is the documented
    /// fallback for a deployment with no Redis.
    func liveTrains() async throws -> LiveTrainsSnapshot {
        try await get("/api/live-trains")
    }

    // MARK: - Commute (signed in)

    func commuteDashboard(commuteId: String? = nil) async throws -> DashboardResponse {
        var items: [URLQueryItem] = []
        if let commuteId { items.append(URLQueryItem(name: "commute", value: commuteId)) }
        return try await get("/api/commute/dashboard", query: items)
    }

    func commutes() async throws -> CommuteListResponse {
        try await get("/api/commute")
    }

    /// "I'm travelling now" — locks the dashboard to this direction and train.
    func startRun(
        commuteId: String,
        legId: String?,
        direction: String,
        originCrs: String,
        originLabel: String,
        destCrs: String,
        destLabel: String
    ) async throws {
        var body: [String: Any] = [
            "direction": direction,
            "originCrs": originCrs,
            "originLabel": originLabel,
            "destCrs": destCrs,
            "destLabel": destLabel,
        ]
        if let legId { body["commuteLegId"] = legId }
        _ = try await send(json: "/api/commute/\(commuteId)/run", method: "POST", body: body) as EmptyOK
    }

    func endRun(commuteId: String) async throws {
        _ = try await send(json: "/api/commute/\(commuteId)/run", method: "DELETE", body: [:]) as EmptyOK
    }

    // MARK: - Commute overrides and holidays

    /// Per-date changes between two `YYYY-MM-DD` dates.
    func overrides(commuteId: String, from: String, to: String) async throws -> OverridesResponse {
        try await get("/api/commute/\(commuteId)/overrides", query: [
            URLQueryItem(name: "from", value: from),
            URLQueryItem(name: "to", value: to),
        ])
    }

    /// Saves an override for one date, or for every future occurrence of that
    /// weekday.
    func saveOverride(
        commuteId: String,
        date: String,
        scope: OverrideScope,
        skipped: Bool? = nil,
        note: String? = nil
    ) async throws {
        var input: [String: Any] = [:]
        if let skipped { input["skipped"] = skipped }
        if let note { input["note"] = note }
        _ = try await send(
            json: "/api/commute/\(commuteId)/overrides",
            method: "POST",
            body: ["date": date, "scope": scope.rawValue, "input": input]
        ) as EmptyOK
    }

    /// Clears a single date's override, restoring the normal pattern.
    func clearOverride(commuteId: String, date: String) async throws {
        _ = try await send(
            json: "/api/commute/\(commuteId)/overrides/\(date)",
            method: "DELETE",
            body: [:]
        ) as EmptyOK
    }

    func holidays() async throws -> HolidaysResponse {
        try await get("/api/commute/holidays")
    }

    func createHoliday(startDate: String, endDate: String, label: String?) async throws {
        var body: [String: Any] = ["startDate": startDate, "endDate": endDate]
        if let label, !label.isEmpty { body["label"] = label }
        _ = try await send(json: "/api/commute/holidays", method: "POST", body: body) as EmptyOK
    }

    func deleteHoliday(id: String) async throws {
        _ = try await send(
            json: "/api/commute/holidays/\(id)",
            method: "DELETE",
            body: [:]
        ) as EmptyOK
    }

    // MARK: - Alerts

    func alerts(unseenOnly: Bool = false) async throws -> AlertsResponse {
        try await get(
            "/api/alerts",
            query: unseenOnly ? [URLQueryItem(name: "unseen", value: "1")] : []
        )
    }

    /// Marks every alert seen — the "clear" action on the list.
    func markAlertsSeen() async throws {
        _ = try await send(json: "/api/alerts", method: "PATCH", body: [:]) as EmptyOK
    }

    /// Marks one alert seen, so reading a single disruption doesn't clear the
    /// rest of the list.
    func markAlertSeen(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await send(json: "/api/alerts/\(encoded)/seen", method: "POST", body: [:]) as EmptyOK
    }

    // MARK: - Fares

    /// Indicative cheapest fare between two stations.
    ///
    /// Public and cacheable. "Indicative" is the route's own word: cheapest
    /// standard single/return from the DTD feed, no railcards, no routeing
    /// guide — the UI must not imply otherwise.
    func fares(from: String, to: String) async throws -> FaresResponse {
        try await get("/api/fares", query: [
            URLQueryItem(name: "from", value: from.uppercased()),
            URLQueryItem(name: "to", value: to.uppercased()),
        ])
    }

    // MARK: - Settings and account

    func accessibilityPrefs() async throws -> AccessibilityPrefsResponse {
        try await get("/api/settings/accessibility")
    }

    func updateAccessibilityPrefs(_ prefs: AccessibilityPrefs) async throws {
        _ = try await send(
            json: "/api/settings/accessibility",
            method: "PATCH",
            body: [
                "reducedMotion": prefs.reducedMotion,
                "textSize": prefs.textSize.rawValue,
                "highContrast": prefs.highContrast,
                "strengthenCues": prefs.strengthenCues,
            ]
        ) as EmptyOK
    }

    func pushPreferences() async throws -> PushPreferences {
        try await get("/api/push/preferences")
    }

    func updatePushPreferences(_ preferences: PushPreferences) async throws {
        _ = try await send(
            json: "/api/push/preferences",
            method: "PATCH",
            body: [
                "commuteDisruptions": preferences.commuteDisruptions,
                "preDeparture": preferences.preDeparture,
                "networkDisruptions": preferences.networkDisruptions,
            ]
        ) as EmptyOK
    }

    /// Permanently deletes the account. Irreversible, and the route does not
    /// confirm — the caller must have asked first.
    func deleteAccount() async throws {
        _ = try await send(json: "/api/account", method: "DELETE", body: [:]) as EmptyOK
    }

    // MARK: - Favourites

    func favourites() async throws -> FavouritesResponse {
        try await get("/api/favourites")
    }

    func addFavourite(from: String, to: String) async throws {
        _ = try await send(
            json: "/api/favourites",
            method: "POST",
            body: ["from": from, "to": to]
        ) as EmptyOK
    }

    func removeFavourite(from: String, to: String) async throws {
        _ = try await send(
            json: "/api/favourites",
            method: "DELETE",
            body: ["from": from, "to": to]
        ) as EmptyOK
    }

    // MARK: - Push

    /// Registers this device for commute alerts. Requires a session.
    func registerDeviceToken(_ token: String, environment: String) async throws {
        _ = try await send(
            json: "/api/push/device",
            method: "POST",
            body: ["token": token, "environment": environment, "platform": "ios"]
        ) as EmptyOK
    }

    func unregisterDeviceToken(_ token: String) async throws {
        _ = try await send(
            json: "/api/push/device",
            method: "DELETE",
            body: ["token": token]
        ) as EmptyOK
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var request = URLRequest(url: try url(path: path, query: query))
        request.httpMethod = "GET"
        return try await send(request)
    }

    /// A JSON-bodied request, for the write endpoints.
    private func send<T: Decodable>(
        json path: String,
        method: String,
        body: [String: Any]
    ) async throws -> T {
        var request = URLRequest(url: try url(path: path, query: []))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
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
            #if DEBUG
            // App Transport Security rejects the request before it leaves the
            // device, so there is no server-side trace and the UI just shows
            // "couldn't reach Signaller". Name it in the console instead of
            // letting it look like the backend is down.
            if error.code == .appTransportSecurityRequiresSecureConnection {
                print("""
                [APIClient] ATS blocked \(request.url?.absoluteString ?? "?").
                Use https, or add the host to NSAppTransportSecurity in Info.plist.
                """)
            }
            #endif
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
