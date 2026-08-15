import Foundation

/// The station list, on device.
///
/// Two problems it solves. First, station typeahead was network-only and is the
/// *only* way to enter a station, so without signal the app could not be used
/// at all — the one thing a rail app must survive is a platform with no bars.
/// Second, even online every keystroke cost a 250ms debounce plus a round trip
/// on the app's most-used control.
///
/// The list is bundled (3,113 stations, ~110KB) so it works on first launch
/// having never been online, and refreshed from `/api/stations` — which
/// returns the full list when called without a query, a contract its own
/// comment describes as "kept for callers that still embed it".
///
/// Ranking is a faithful port of that route's `rank()`, so offline and online
/// results agree. Diverging would be worse than being offline: the same query
/// would silently give different answers depending on signal.
@Observable
@MainActor
final class StationIndex {
    private(set) var stations: [Station] = []
    private(set) var source: Source = .none

    enum Source: Equatable {
        case none
        /// Shipped with the app.
        case bundled
        /// Refreshed from the API, with the time it was stored.
        case cached(storedAt: Date)
    }

    /// Ranks stations for a typeahead query.
    ///
    /// Port of `rank()` in `apps/web/app/api/stations/route.ts`: exact CRS
    /// first, then name prefix, then a word within the name, then anywhere.
    /// The scan stops early once 60 candidates are found, and the result is
    /// capped at 20 — both matching the route.
    static func rank(_ stations: [Station], query: String) -> [Station] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }

        var exactCrs: [Station] = []
        var prefix: [Station] = []
        var word: [Station] = []
        var contains: [Station] = []

        for station in stations {
            let name = station.name.lowercased()
            if station.crs.lowercased() == q {
                exactCrs.append(station)
            } else if name.hasPrefix(q) {
                prefix.append(station)
            } else if name.contains(" \(q)") {
                word.append(station)
            } else if name.contains(q) {
                contains.append(station)
            }
            if exactCrs.count + prefix.count + word.count + contains.count > 60 { break }
        }

        return Array((exactCrs + prefix + word + contains).prefix(20))
    }

    func search(_ query: String) -> [Station] {
        Self.rank(stations, query: query)
    }

    // MARK: - Loading

    /// Cache first, then the bundle. Both are local, so this never blocks on
    /// the network.
    func load(cache: ResponseCache) async {
        if let cached = await cache.load([Station].self, for: .stations),
           !cached.value.isEmpty {
            stations = cached.value
            source = .cached(storedAt: cached.storedAt)
            return
        }
        loadBundled()
    }

    func loadBundled() {
        guard let url = Bundle.main.url(forResource: "stations", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder.signaller.decode([Station].self, from: data)
        else { return }
        stations = decoded
        source = .bundled
    }

    /// Refreshes from the API in the background. Failure is silent by design —
    /// the bundled list is already serving.
    func refresh(using api: APIClient, cache: ResponseCache) async {
        guard let fresh = try? await api.allStations(), !fresh.isEmpty else { return }
        stations = fresh
        source = .cached(storedAt: Date())
        await cache.store(fresh, for: .stations)
    }
}
