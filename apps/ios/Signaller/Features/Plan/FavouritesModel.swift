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

    /// Set when a toggle failed, so the star can explain itself. Tapping a
    /// star and getting no response and no reason is the worst of both.
    var toggleError: String?

    func load(using api: APIClient) async {
        do {
            let response = try await api.favourites()
            favourites = response.favourites
            loaded = true
        } catch APIError.unauthorized {
            // Signed out: no favourites is the correct answer, not an error.
            favourites = []
            loaded = true
        } catch {
            // A transport failure is different — keep whatever is on screen
            // and leave `loaded` false so the caller can retry.
        }
    }

    func contains(from: String, to: String) -> Bool {
        favourites.contains { $0.from == from.uppercased() && $0.to == to.uppercased() }
    }

    /// Adds or removes, and reconciles with the server afterwards.
    ///
    /// Optimistic: the star flips immediately and rolls back if the write
    /// fails, so the control always reflects either the truth or an
    /// explanation — never silence.
    func toggle(from: String, to: String, using api: APIClient) async {
        let isFavourite = contains(from: from, to: to)
        let rollback = favourites
        toggleError = nil

        if isFavourite {
            favourites.removeAll { $0.from == from.uppercased() && $0.to == to.uppercased() }
        } else {
            favourites.append(
                Favourite(
                    from: from.uppercased(),
                    to: to.uppercased(),
                    // Names arrive with the reload; the star only needs the pair.
                    fromName: nil,
                    toName: nil,
                    lastUsedAt: nil
                )
            )
        }

        do {
            if isFavourite {
                try await api.removeFavourite(from: from, to: to)
            } else {
                try await api.addFavourite(from: from, to: to)
            }
            await load(using: api)
        } catch {
            favourites = rollback
            toggleError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
