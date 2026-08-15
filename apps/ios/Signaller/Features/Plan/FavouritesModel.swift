import Foundation
import Observation

/// Saved from→to pairs.
///
/// Shared across the Plan screen (the star) and the saved-journeys list, so
/// toggling in one place is reflected in the other without a refetch.
@Observable
@MainActor
final class FavouritesModel {
    private(set) var favourites: [Favourite] = []
    private(set) var loaded = false

    func load(using api: APIClient) async {
        // Signed-out users have none; the route 401s and that's not an error
        // worth showing on a screen that works fine without it.
        guard let response = try? await api.favourites() else { return }
        favourites = response.favourites
        loaded = true
    }

    func contains(from: String, to: String) -> Bool {
        favourites.contains { $0.from == from.uppercased() && $0.to == to.uppercased() }
    }

    /// Adds or removes, and reconciles with the server afterwards.
    func toggle(from: String, to: String, using api: APIClient) async {
        let isFavourite = contains(from: from, to: to)
        do {
            if isFavourite {
                try await api.removeFavourite(from: from, to: to)
            } else {
                try await api.addFavourite(from: from, to: to)
            }
            await load(using: api)
        } catch {
            // Leave the stored list untouched — it still reflects the server.
        }
    }
}
