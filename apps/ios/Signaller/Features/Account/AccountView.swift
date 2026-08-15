import SwiftUI

/// Account tab: the sign-in screen when signed out, account details when in.
///
/// Commute, favourites and alert settings land here in Phase 7 — for now it's
/// the entry point that makes sign-in reachable at all.
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

            Card {
                Button("Sign out") {
                    Task { await env.authClient.signOut() }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }
}
