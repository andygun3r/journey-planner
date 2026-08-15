import SwiftUI

@main
struct SignallerApp: App {
    /// One environment for the whole app: a single auth token, one API client,
    /// one Live Activity controller.
    @State private var env = AppEnvironment()

    /// Only here to receive the APNs token — SwiftUI has no equivalent hook.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(env)
                // Magic-link callbacks and notification taps both land here.
                .onOpenURL { env.handle(url: $0) }
                .task {
                    AppDelegate.environment = env
                    await env.push.refreshAuthorizationStatus()
                    // A token that arrived before sign-in, or whose upload
                    // failed, gets another go on every launch.
                    await env.push.sendPendingToken()
                }
        }
    }
}
