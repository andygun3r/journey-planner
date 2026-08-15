import SwiftUI

/// The tab bar. Each tab owns its own `NavigationStack` so pushing a service
/// detail from a board doesn't disturb what's on screen in Plan.
struct RootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var selection: Tab = .plan

    enum Tab: Hashable {
        case plan, map, boards, commute, account
    }

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
