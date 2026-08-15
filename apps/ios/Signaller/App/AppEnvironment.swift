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
    /// Last-known-good responses, so a cold launch without signal still has
    /// something to show.
    let cache = ResponseCache()
    /// The on-device station list, so the typeahead works offline.
    let stations = StationIndex()

    /// Where a deep link wants the app to go, consumed by `RootView`.
    var pendingLink: DeepLink?

    /// A station whose board a deep link asked for, consumed by `BoardsView`.
    ///
    /// `RootView` used to select the Boards tab and drop the CRS on the floor,
    /// so tapping a board notification landed on an empty "Pick a station"
    /// screen. The tab selection was never the payload — this is.
    var pendingBoardCRS: String?

    /// A train a deep link asked for, consumed by `BoardsView`'s navigation
    /// stack. Same defect as `pendingBoardCRS`.
    var pendingServiceID: String?

    /// A from→to pair to plan, set by the commute dashboard's quick-start.
    ///
    /// Commute used to *push* the whole planner inside its own tab, so the app
    /// carried two `PlanModel`s with different state. Now it hands the pair
    /// over and switches tab, and there is one planner.
    var pendingJourney: JourneyQuery?

    /// A tab a screen has asked the app to switch to.
    ///
    /// `selectedTab` in the environment is read-only by design — one owner of
    /// the selection — so a child that needs to move the user (the signed-out
    /// commute card sending them to sign in) posts the request here and
    /// `RootView` performs it.
    var requestedTab: RootView.Tab?

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

    /// Loads the station index and clears out anything long-expired.
    ///
    /// Both are local and fast; the network refresh is fire-and-forget so a
    /// dead connection never delays a launch.
    func prepare() async {
        await stations.load(cache: cache)
        await cache.purge(olderThan: CacheAge.purge)
        Task { await stations.refresh(using: api, cache: cache) }
    }

    /// Signs out and stops alerts reaching this device.
    func signOut() async {
        // Unregister first: after signOut() there's no token to authenticate
        // the request with, so the row would be left behind.
        await push.unregister()
        await authClient.signOut()
        // Cached dashboards, alerts and favourites belong to the account that
        // fetched them — they must not survive into the next sign-in.
        await cache.remove(.dashboard)
        await cache.remove(.alerts)
        await cache.remove(.favourites)
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
