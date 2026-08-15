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
                // Light-only by design — PRODUCT.md's One-Theme Rule. This
                // pairs with `UIUserInterfaceStyle = Light` in Info.plist:
                // the plist setting covers UIKit-owned chrome (tab bar,
                // navigation bar, keyboard, sheets), this covers the SwiftUI
                // hierarchy including anything presented in its own window.
                // Both are needed, and without them the app's hardcoded light
                // surfaces met the system's white Dark Mode label colour.
                .preferredColorScheme(.light)
                // Status pills gain a symbol alongside their colour when the
                // system asks for it.
                .modifier(StrengthenCuesFromSystem())
                // Magic-link callbacks and notification taps both land here.
                .onOpenURL { env.handle(url: $0) }
                .task {
                    AppDelegate.environment = env
                    // Station index and cache housekeeping, both local.
                    await env.prepare()
                    await env.push.refreshAuthorizationStatus()
                    // A token that arrived before sign-in, or whose upload
                    // failed, gets another go on every launch.
                    await env.push.sendPendingToken()
                }
        }
    }
}
