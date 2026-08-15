import SwiftUI

/// The tab bar. Each tab owns its own `NavigationStack` so pushing a service
/// detail from a board doesn't disturb what's on screen in Plan.
struct RootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var selection: Tab?

    enum Tab: Hashable {
        case trains, map, commute, status, account
    }

    /// Opens on the commute for anyone signed in, and on Trains otherwise.
    ///
    /// The app used to open on a blank journey-search form while Commute — the
    /// app's namesake, and the screen a commuter actually opens at 7am — sat
    /// fourth in the bar. Resolved once at launch rather than bound directly,
    /// so signing out mid-session doesn't yank the tab out from under anyone.
    private var defaultTab: Tab {
        env.auth.isSignedIn ? .commute : .trains
    }

    /// The visible tab, published so live streams can stand down when their
    /// screen is no longer on top. A `TabView` keeps sibling tabs alive, so
    /// `onDisappear` never fires on a tab switch and can't be used for this.

    var body: some View {
        TabView(selection: $selection) {
            // Departures and journey planning are the same task with one end
            // or two, so they share a tab. That is what frees the slot Status
            // now occupies.
            NavigationStack {
                TrainsView()
            }
            .tabItem { Label("Trains", systemImage: "tram") }
            .tag(Tab.trains)

            NavigationStack {
                LiveMapView()
            }
            .tabItem { Label("Map", systemImage: "map") }
            .tag(Tab.map)

            NavigationStack {
                CommuteView()
            }
            .tabItem { Label("Commute", systemImage: "calendar") }
            .tag(Tab.commute)

            // Promoted out from under Account: punctuality, disruptions,
            // engineering work and Tube status are passenger information, and
            // they were two taps deep behind a profile icon.
            NavigationStack {
                StatusView()
            }
            .tabItem { Label("Status", systemImage: "waveform.path.ecg") }
            .tag(Tab.status)

            NavigationStack {
                AccountView()
            }
            .tabItem { Label("Account", systemImage: "person.crop.circle") }
            .tag(Tab.account)
        }
        .environment(\.selectedTab, selection ?? defaultTab)
        .task {
            // Auth is restored asynchronously at launch, so the landing tab is
            // chosen once it's known rather than defaulting to signed-out.
            if selection == nil { selection = defaultTab }
        }
        // A screen asking to move the user — the signed-out commute card
        // sending them to sign in.
        .onChange(of: env.requestedTab) { _, tab in
            guard let tab else { return }
            selection = tab
            env.requestedTab = nil
        }
        .tint(Palette.railNavy)
        // A deep link or a notification tap selects the tab it belongs to.
        // Consumed here (and cleared) so the same link can arrive twice.
        .onChange(of: env.pendingLink) { _, link in
            guard let link else { return }
            switch link {
            case .commute:
                selection = .commute
            case let .board(crs):
                // Carry the payload, not just the destination: selecting the
                // tab and discarding the CRS is what made every board
                // notification open an empty screen.
                env.pendingBoardCRS = crs
                selection = .trains
            case let .service(id):
                env.pendingServiceID = id
                selection = .trains
            case .authToken:
                selection = .account
            }
            env.pendingLink = nil
        }
    }
}

/// The tab currently on screen.
///
/// Read by screens that own a live stream, so they can stop it when the user
/// switches away — `onDisappear` doesn't fire for a `TabView`'s siblings.
private struct SelectedTabKey: EnvironmentKey {
    static let defaultValue: RootView.Tab = .trains
}

extension EnvironmentValues {
    var selectedTab: RootView.Tab {
        get { self[SelectedTabKey.self] }
        set { self[SelectedTabKey.self] = newValue }
    }
}
