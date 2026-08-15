import SwiftUI

@main
struct SignallerApp: App {
    /// One environment for the whole app: a single auth token, one API client,
    /// one Live Activity controller.
    @State private var env = AppEnvironment()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(env)
                // Magic-link callbacks and notification taps both land here.
                .onOpenURL { env.handle(url: $0) }
        }
    }
}
