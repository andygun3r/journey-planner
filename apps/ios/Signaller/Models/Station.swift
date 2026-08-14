import Foundation

/// Results from `/api/stations?q=&places=1`.
///
/// Stations and places stay in **separate arrays** and must not be merged into
/// one ranked list. The web app is deliberate about this (see the comment in
/// `apps/web/app/api/stations/route.ts`): this is a rail app, so a station must
/// never lose its position in the list to a similarly-named shop. Render
/// stations first, places under them.
struct StationSearchResponse: Decodable {
    let stations: [Station]
    let places: [Place]

    init(stations: [Station], places: [Place]) {
        self.stations = stations
        self.places = places
    }

    /// The route omits `places` entirely without `?places=1`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        stations = try container.decodeIfPresent([Station].self, forKey: .stations) ?? []
        places = try container.decodeIfPresent([Place].self, forKey: .places) ?? []
    }

    private enum CodingKeys: String, CodingKey { case stations, places }

    var isEmpty: Bool { stations.isEmpty && places.isEmpty }
}

struct Station: Decodable, Identifiable, Hashable {
    var id: String { crs }
    let crs: String
    let name: String
}

/// A free-text address result from OS Places.
struct Place: Decodable, Identifiable, Hashable {
    /// Stable OS identifier (UPRN where present).
    let id: String
    /// Full single-line address as OS formats it.
    let label: String
    /// Shorter leading portion, for a row that must not wrap.
    let shortLabel: String
    let lat: Double
    let lon: Double
    let postcode: String?

    /// How a place is addressed when planning: re-resolved server-side at plan
    /// time, so a shared link keeps working.
    var journeyEndpoint: String { "place:\(id)" }
}
