import AuthenticationServices
import SwiftUI
import Observation

@Observable
@MainActor
final class SignInModel {
    enum Phase {
        case idle
        case working
        /// Magic link sent; waiting for the user to open it.
        case linkSent(email: String)
        case failed(String)
    }

    var email = ""
    private(set) var phase: Phase = .idle

    var canSubmitEmail: Bool {
        // Deliberately loose: the server is the authority on what's valid, and
        // rejecting "a@b.co" client-side would be worse than a wasted request.
        email.contains("@") && email.count >= 5
    }

    func signInWithPasskey(client: AuthClient, anchor: ASPresentationAnchor) async {
        phase = .working
        do {
            try await client.signInWithPasskey(presentationAnchor: anchor)
            phase = .idle
        } catch let error as ASAuthorizationError where error.code == .canceled {
            // Dismissing Face ID is a decision, not a failure — say nothing.
            phase = .idle
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    func sendMagicLink(client: AuthClient) async {
        phase = .working
        do {
            try await client.requestMagicLink(email: email)
            phase = .linkSent(email: email)
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    private static func message(for error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

/// Sign-in. Passkey first, email as the way in on a new device.
///
/// Note for Debug builds: passkeys need the Associated Domains entitlement,
/// which a free Personal Team can't issue — so `SIGNALLER_CODE_SIGN_ENTITLEMENTS_DEBUG`
/// is normally blank and the passkey button will fail on a locally-signed
/// build. The magic-link path below works either way, which is why it's here
/// rather than hidden behind a "trouble signing in?" link.
struct SignInView: View {
    @State private var model = SignInModel()
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Sign in") {
            Card {
                Text("Sign in to Signaller")
                    .font(.title3.weight(.bold))
                Text("Commutes, alerts and saved journeys are tied to your account.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)

                Button("Sign in with a passkey") {
                    Task {
                        guard let anchor = Self.presentationAnchor() else { return }
                        await model.signInWithPasskey(client: env.authClient, anchor: anchor)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isWorking)
            }

            Card {
                LabelText("Or sign in by email")
                Text("We'll email you a link that opens straight back here.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)

                TextField("you@example.com", text: $model.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .background(Palette.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.black.opacity(0.08))
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                Button("Email me a link") {
                    Task { await model.sendMagicLink(client: env.authClient) }
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(!model.canSubmitEmail || isWorking)
            }

            statusCard
        }
    }

    @ViewBuilder
    private var statusCard: some View {
        // A magic link that failed on open is reported by AppEnvironment, since
        // the exchange happens outside this view.
        if let linkError = env.signInError {
            EmptyStateCard(
                title: "That link didn't work",
                message: linkError,
                systemImage: "link.badge.plus"
            )
        }

        switch model.phase {
        case .working:
            Card {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Signing in…").foregroundStyle(Palette.inkMuted)
                }
            }
        case let .linkSent(email):
            Card {
                HStack(spacing: 8) {
                    Image(systemName: "envelope.badge").foregroundStyle(Palette.signalGreen)
                    Text("Check your email").font(.body.weight(.semibold))
                }
                Text("We sent a sign-in link to \(email). Open it on this device.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            }
        case let .failed(message):
            EmptyStateCard(
                title: "Couldn't sign in",
                message: message,
                systemImage: "exclamationmark.triangle"
            )
        case .idle:
            EmptyView()
        }
    }

    private var isWorking: Bool {
        if case .working = model.phase { return true }
        return false
    }

    /// The window to present the passkey sheet over.
    private static func presentationAnchor() -> ASPresentationAnchor? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?
            .keyWindow
    }
}
