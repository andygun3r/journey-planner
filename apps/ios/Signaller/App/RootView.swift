import SwiftUI

/// The tab bar. Each tab owns its own `NavigationStack` so pushing a service
/// detail from a board doesn't disturb what's on screen in Plan.
struct RootView: View {
    var body: some View {
        TabView {
            NavigationStack {
                PlanView()
            }
            .tabItem { Label("Plan", systemImage: "tram") }

            NavigationStack {
                BoardsView()
            }
            .tabItem { Label("Boards", systemImage: "clock") }

            NavigationStack {
                StatusView()
            }
            .tabItem { Label("Status", systemImage: "waveform.path.ecg") }
        }
        .tint(Palette.railNavy)
    }
}
