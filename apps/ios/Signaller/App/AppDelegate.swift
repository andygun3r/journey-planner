import UIKit
import UserNotifications

/// SwiftUI has no way to receive the APNs token, so this exists purely to
/// bridge the three UIKit callbacks that carry it into `PushRegistrar`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by `SignallerApp` once the environment is built.
    @MainActor static var environment: AppEnvironment?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            Self.environment?.push.didRegister(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            Self.environment?.push.didFailToRegister(error: error)
        }
    }

    /// Show alerts even while the app is open. A commute disruption is exactly
    /// as urgent when you happen to be looking at the app as when you aren't.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// Tapping a notification opens what it's about.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        // The sender puts a path here (currently always "/commute").
        guard let path = info["url"] as? String else { return }

        await MainActor.run {
            // Reuse the deep-link route the URL scheme already goes through,
            // so a tap and a signaller:// link land in the same place.
            let normalised = path.hasPrefix("/") ? String(path.dropFirst()) : path
            guard let url = URL(string: "signaller://\(normalised)") else { return }
            Self.environment?.handle(url: url)
        }
    }
}
