import Observation
import SwiftUI

@Observable
@MainActor
final class SettingsModel {
    private(set) var accessibility = AccessibilityPrefs.default
    private(set) var push = PushPreferences.default
    private(set) var loaded = false
    /// Shown when a save didn't stick, so a toggle can't silently revert.
    var saveError: String?
    var deleteError: String?
    private(set) var deleting = false

    func load(using api: APIClient) async {
        // Both are optional extras on a screen that still works without them,
        // so a failure leaves the defaults rather than blocking the screen.
        if let response = try? await api.accessibilityPrefs() {
            accessibility = response.prefs
        }
        if let preferences = try? await api.pushPreferences() {
            push = preferences
        }
        loaded = true
    }

    /// Applies a change optimistically and rolls back if the server refuses,
    /// so a switch always shows either the truth or an explanation.
    func updateAccessibility(_ change: (inout AccessibilityPrefs) -> Void, using api: APIClient) async {
        let rollback = accessibility
        var updated = accessibility
        change(&updated)
        accessibility = updated
        saveError = nil
        do {
            try await api.updateAccessibilityPrefs(updated)
        } catch {
            accessibility = rollback
            saveError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func updatePush(_ change: (inout PushPreferences) -> Void, using api: APIClient) async {
        let rollback = push
        var updated = push
        change(&updated)
        push = updated
        saveError = nil
        do {
            try await api.updatePushPreferences(updated)
        } catch {
            push = rollback
            saveError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Returns true when the account is gone and the caller should sign out.
    func deleteAccount(using api: APIClient) async -> Bool {
        deleting = true
        defer { deleting = false }
        do {
            deleteError = nil
            try await api.deleteAccount()
            return true
        } catch {
            deleteError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }
}

/// Account preferences: accessibility, which alerts to send, and account
/// deletion.
///
/// The accessibility route's own comment says "the native app applies these
/// alongside the system's own settings" — the backend was written expecting
/// this screen, and until now nothing called it.
struct SettingsView: View {
    @State private var model = SettingsModel()
    @Environment(AppEnvironment.self) private var env
    @State private var confirmingDelete = false

    var body: some View {
        AppChrome(title: "Settings") {
            accessibilityCard
            alertsCard
            if let error = model.saveError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRedText)
            }
            dangerCard
        }
        .task { await model.load(using: env.api) }
    }

    // MARK: - Accessibility

    private var accessibilityCard: some View {
        Card {
            LabelText("Accessibility")
            Text("These apply on top of your device's own settings, not instead of them.")
                .font(.caption)
                .foregroundStyle(Palette.inkMuted)

            Toggle(
                "Reduce motion",
                isOn: Binding(
                    get: { model.accessibility.reducedMotion },
                    set: { value in
                        Task {
                            await model.updateAccessibility({ $0.reducedMotion = value }, using: env.api)
                        }
                    }
                )
            )
            .frame(minHeight: 44)

            Toggle(
                "Higher contrast",
                isOn: Binding(
                    get: { model.accessibility.highContrast },
                    set: { value in
                        Task {
                            await model.updateAccessibility({ $0.highContrast = value }, using: env.api)
                        }
                    }
                )
            )
            .frame(minHeight: 44)

            Toggle(
                "Symbols with status colours",
                isOn: Binding(
                    get: { model.accessibility.strengthenCues },
                    set: { value in
                        Task {
                            await model.updateAccessibility({ $0.strengthenCues = value }, using: env.api)
                        }
                    }
                )
            )
            .frame(minHeight: 44)

            Picker(
                "Text size",
                selection: Binding(
                    get: { model.accessibility.textSize },
                    set: { value in
                        Task {
                            await model.updateAccessibility({ $0.textSize = value }, using: env.api)
                        }
                    }
                )
            ) {
                ForEach(AccessibilityPrefs.TextSize.allCases, id: \.self) { size in
                    Text(size.label).tag(size)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Push categories

    private var alertsCard: some View {
        Card {
            LabelText("Which alerts to send")
            Text("Your device's notification permission decides whether these can arrive at all.")
                .font(.caption)
                .foregroundStyle(Palette.inkMuted)

            Toggle(
                "Commute disruptions",
                isOn: Binding(
                    get: { model.push.commuteDisruptions },
                    set: { value in
                        Task { await model.updatePush({ $0.commuteDisruptions = value }, using: env.api) }
                    }
                )
            )
            .frame(minHeight: 44)

            Toggle(
                "Before you leave",
                isOn: Binding(
                    get: { model.push.preDeparture },
                    set: { value in
                        Task { await model.updatePush({ $0.preDeparture = value }, using: env.api) }
                    }
                )
            )
            .frame(minHeight: 44)

            Toggle(
                "Network-wide disruption",
                isOn: Binding(
                    get: { model.push.networkDisruptions },
                    set: { value in
                        Task { await model.updatePush({ $0.networkDisruptions = value }, using: env.api) }
                    }
                )
            )
            .frame(minHeight: 44)
        }
    }

    // MARK: - Account deletion

    /// Required by App Review for any app that offers account creation, and
    /// the right thing regardless — an account you can't delete in the app is
    /// an account you're stuck with.
    private var dangerCard: some View {
        Card {
            LabelText("Account")
            Text("Deleting removes your commutes, saved journeys and alert history. It can't be undone.")
                .font(.callout)
                .foregroundStyle(Palette.inkMuted)

            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                if model.deleting {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 48)
                } else {
                    Text("Delete account")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.onNavy)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 48)
                        .background(Palette.signalRed)
                        .clipShape(Capsule())
                }
            }
            .buttonStyle(.plain)
            .disabled(model.deleting)

            if let error = model.deleteError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRedText)
            }
        }
        .alert("Delete your account?", isPresented: $confirmingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    if await model.deleteAccount(using: env.api) {
                        // The account is gone; clear the local session so the
                        // app doesn't keep a token that authenticates nothing.
                        await env.signOut()
                    }
                }
            }
        } message: {
            Text("This permanently removes your commutes, saved journeys and alert history. It can't be undone.")
        }
    }
}
