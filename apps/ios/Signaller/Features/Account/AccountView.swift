import SwiftUI
import UserNotifications

/// Account tab: sign-in, notification settings, and the way through to
/// network status.
///
/// Signed out it shows the sign-in screen — but network status is still
/// reachable from there, since it needs no account and is one of the things
/// people open the app for.
struct AccountView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        if env.auth.isSignedIn {
            signedIn
        } else {
            SignInView()
        }
    }

    private var signedIn: some View {
        AppChrome(title: "Account") {
            Card {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Palette.signalGreen)
                    Text("Signed in").font(.body.weight(.semibold))
                }
                Text("Commutes, alerts and saved journeys sync to this account.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            }

            notificationsCard

            Card {
                NavigationLink {
                    StatusView()
                } label: {
                    HStack {
                        Label("Network status", systemImage: "waveform.path.ecg")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.ink)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Palette.inkMuted)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            Card {
                Button("Sign out") {
                    Task { await env.signOut() }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
        .task { await env.push.refreshAuthorizationStatus() }
    }

    /// Notification permission, asked for here rather than on launch — an
    /// unprompted permission dialog is the fastest route to a permanent "no".
    @ViewBuilder
    private var notificationsCard: some View {
        Card {
            LabelText("Commute alerts")
            switch env.push.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                HStack(spacing: 8) {
                    Image(systemName: "bell.fill").foregroundStyle(Palette.signalGreen)
                    Text("Alerts are on").font(.body.weight(.semibold))
                }
                Text("You'll be told about cancellations and delays on your commute, even when the app is closed.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)

            case .denied:
                Text("Notifications are turned off for Signaller.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
                // Only iOS can re-grant permission, so send them there.
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(SecondaryButtonStyle())

            case .notDetermined:
                Text("Get told about cancellations and delays on your commute.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
                Button("Turn on alerts") {
                    Task { await env.push.requestAuthorization() }
                }
                .buttonStyle(SecondaryButtonStyle())

            @unknown default:
                EmptyView()
            }

            if let error = env.push.lastError {
                Text(error).font(.caption).foregroundStyle(Palette.signalAmber)
            }
        }
    }
}
