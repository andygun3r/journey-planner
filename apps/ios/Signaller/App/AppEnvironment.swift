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
    let push: PushRegistrar
    let favourites = FavouritesModel()

    /// Where a deep link wants the app to go, consumed by `RootView`.
    var pendingLink: DeepLink?

    /// Set when a magic link fails to complete, so the sign-in screen can say
    /// what went wrong rather than appearing to ignore the tap.
    var signInError: String?

    init() {
        let auth = AuthStore()
        let api = APIClient(auth: auth)
        self.auth = auth
        self.api = api
        self.authClient = AuthClient(baseURL: api.baseURL, store: auth)
        self.liveActivities = LiveActivityController()
        self.push = PushRegistrar(api: api, auth: auth)
    }

    /// Signs out and stops alerts reaching this device.
    func signOut() async {
        // Unregister first: after signOut() there's no token to authenticate
        // the request with, so the row would be left behind.
        await push.unregister()
        await authClient.signOut()
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
                    signInError = nil
                    try await authClient.completeMagicLink(token: token)
                } catch {
                    // Magic links are single-use and time-limited, so this
                    // usually means the link was already opened or has expired.
                    // Say so — an ignored tap looks like a broken app.
                    signInError = (error as? APIError)?.errorDescription
                        ?? "That sign-in link didn't work. Request a new one."
                }
            }
        case .board, .service, .commute:
            pendingLink = link
        }
    }
}
