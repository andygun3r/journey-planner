import Foundation
import Observation

/// The app's long-lived collaborators, created once and injected into the view
/// tree. Screens reach for these via `@Environment(AppEnvironment.self)` rather
/// than constructing their own clients, so there's exactly one auth token and
/// one Live Activity controller in play.
@Observable
@MainActor
final class AppEnvironment {
    let auth: AuthStore
    let api: APIClient
    let authClient: AuthClient
    let liveActivities: LiveActivityController

    /// Where a deep link wants the app to go, consumed by `RootView`.
    var pendingLink: DeepLink?

    init() {
        let auth = AuthStore()
        let api = APIClient(auth: auth)
        self.auth = auth
        self.api = api
        self.authClient = AuthClient(baseURL: api.baseURL, store: auth)
        self.liveActivities = LiveActivityController()
    }

    /// Entry point for `signaller://` and universal links.
    ///
    /// Auth tokens are exchanged here rather than in a view, so a magic link
    /// works no matter which screen happens to be showing when it opens.
    func handle(url: URL) {
        guard let link = DeepLink(url: url) else { return }
        switch link {
        case let .authToken(token):
            Task {
                do {
                    try await authClient.completeMagicLink(token: token)
                } catch {
                    // The link is single-use and time-limited, so a failure
                    // here usually means it was already used or has expired.
                    // Leave the user on the sign-in screen to try again.
                }
            }
        case .board, .service, .commute:
            pendingLink = link
        }
    }
}
