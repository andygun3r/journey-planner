import SwiftUI

/// The tab bar. Each tab owns its own `NavigationStack` so pushing a service
/// detail from a board doesn't disturb what's on screen in Plan.
struct RootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var selection: Tab = .plan

    enum Tab: Hashable {
        case plan, map, boards, commute, account
    }

    /// The visible tab, published so live streams can stand down when their
    /// screen is no longer on top. A `TabView` keeps sibling tabs alive, so
    /// `onDisappear` never fires on a tab switch and can't be used for this.

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                PlanView()
            }
            .tabItem { Label("Plan", systemImage: "tram") }
            .tag(Tab.plan)

            NavigationStack {
                LiveMapView()
            }
            .tabItem { Label("Map", systemImage: "map") }
            .tag(Tab.map)

            NavigationStack {
                BoardsView()
            }
            .tabItem { Label("Boards", systemImage: "clock") }
            .tag(Tab.boards)

            NavigationStack {
                CommuteView()
            }
            .tabItem { Label("Commute", systemImage: "calendar") }
            .tag(Tab.commute)

            // Five is the most a bottom bar holds without collapsing into
            // "More", so network status lives under Account — it's a
            // check-occasionally screen, not a daily one.
            NavigationStack {
                AccountView()
            }
            .tabItem { Label("Account", systemImage: "person.crop.circle") }
            .tag(Tab.account)
        }
        .environment(\.selectedTab, selection)
        .tint(Palette.railNavy)
        // A deep link or a notification tap selects the tab it belongs to.
        // Consumed here (and cleared) so the same link can arrive twice.
        .onChange(of: env.pendingLink) { _, link in
            guard let link else { return }
            switch link {
            case .commute: selection = .commute
            case .board: selection = .boards
            case .service: selection = .boards
            case .authToken: selection = .account
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
    static let defaultValue: RootView.Tab = .plan
}

extension EnvironmentValues {
    var selectedTab: RootView.Tab {
        get { self[SelectedTabKey.self] }
        set { self[SelectedTabKey.self] = newValue }
    }
}
