import Foundation
import Observation
import UIKit
import UserNotifications

/// Asks for notification permission and keeps the APNs token registered.
///
/// The token is only useful once the user is signed in — alerts are tied to an
/// account's commutes — so registration waits for a session and re-runs when
/// one appears.
@Observable
@MainActor
final class PushRegistrar: NSObject {
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    private(set) var lastError: String?

    /// The most recent token from APNs, held so it can be sent once the user
    /// signs in (or re-sent if the first attempt failed).
    private var pendingToken: String?
    private var registeredToken: String?

    private let api: APIClient
    private let auth: AuthStore

    init(api: APIClient, auth: AuthStore) {
        self.api = api
        self.auth = auth
        super.init()
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await UNUserNotificationCenter.current()
            .notificationSettings()
            .authorizationStatus
    }

    /// Prompts for permission, then registers with APNs if granted.
    ///
    /// Only call this when the user has asked for alerts — an unprompted
    /// permission dialog on launch is the fastest way to a permanent "no".
    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorizationStatus()
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
            return granted
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Called from the app delegate when APNs hands over a token.
    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        pendingToken = hex
        Task { await sendPendingToken() }
    }

    func didFailToRegister(error: Error) {
        // Common and not alarming on a simulator, which has no APNs.
        lastError = error.localizedDescription
    }

    /// Sends the token once there's a session to attach it to. Safe to call
    /// repeatedly — it no-ops when there's nothing new to send.
    func sendPendingToken() async {
        guard auth.isSignedIn, let token = pendingToken, token != registeredToken else { return }
        do {
            try await api.registerDeviceToken(token, environment: Self.environment)
            registeredToken = token
            lastError = nil
        } catch {
            // Leave `pendingToken` set so the next sign-in or launch retries.
            lastError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Unregisters this device — on sign-out, so alerts stop reaching a phone
    /// whose owner has left the account.
    func unregister() async {
        guard let token = registeredToken ?? pendingToken else { return }
        try? await api.unregisterDeviceToken(token)
        registeredToken = nil
    }

    /// A token is only valid against the APNs host that issued it. A Debug
    /// build talks to sandbox; anything else is production.
    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
}
