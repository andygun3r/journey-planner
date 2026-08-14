import AuthenticationServices
import Foundation

/// Sign-in against Better Auth.
///
/// Two routes in, both passwordless (the server has `emailAndPassword`
/// disabled):
///
///   passkey — the everyday path. Face ID, nothing to type. Needs the
///     Associated Domains entitlement and the app-site-association file the
///     web app serves.
///   magic link — the bootstrap. A device with no passkey yet signs in by
///     email, then registers one so the next launch is one tap.
///
/// Both finish the same way: Better Auth's `bearer()` plugin returns the
/// session token in a `set-auth-token` response header, which goes to the
/// Keychain via `AuthStore`.
@MainActor
final class AuthClient {
    private let baseURL: URL
    private let store: AuthStore
    private let session: URLSession

    /// The header the bearer plugin uses to hand back a fresh session token.
    private static let tokenHeader = "set-auth-token"

    init(baseURL: URL, store: AuthStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.store = store
        self.session = session
    }

    // MARK: - Passkey

    /// Signs in with an existing passkey.
    func signInWithPasskey(presentationAnchor: ASPresentationAnchor) async throws {
        let options = try await fetchAuthenticationOptions()
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: options.rpId
        )
        let request = provider.createCredentialAssertionRequest(
            challenge: try decodeBase64URL(options.challenge)
        )

        let credential = try await PasskeyPresenter(anchor: presentationAnchor)
            .perform(request: request)

        guard let assertion = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw APIError.decoding("Unexpected passkey credential type")
        }
        try await verifyAuthentication(assertion)
    }

    private func fetchAuthenticationOptions() async throws -> PasskeyOptions {
        var request = URLRequest(url: endpoint("/api/auth/passkey/generate-authenticate-options"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await send(request)
        try ensureSuccess(response, data: data)
        return try JSONDecoder().decode(PasskeyOptions.self, from: data)
    }

    private func verifyAuthentication(
        _ assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion
    ) async throws {
        // WebAuthn is a base64url-over-JSON protocol; the raw Data has to be
        // re-encoded exactly as the server expects.
        let body: [String: Any] = [
            "response": [
                "id": base64URL(assertion.credentialID),
                "rawId": base64URL(assertion.credentialID),
                "type": "public-key",
                "response": [
                    "clientDataJSON": base64URL(assertion.rawClientDataJSON),
                    "authenticatorData": base64URL(assertion.rawAuthenticatorData),
                    "signature": base64URL(assertion.signature),
                    "userHandle": base64URL(assertion.userID),
                ],
            ],
        ]

        var request = URLRequest(url: endpoint("/api/auth/passkey/verify-authentication"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await send(request)
        try ensureSuccess(response, data: data)
        try captureToken(from: response)
    }

    // MARK: - Magic link

    /// Emails a sign-in link that opens straight back into the app.
    func requestMagicLink(email: String) async throws {
        var request = URLRequest(url: endpoint("/api/auth/sign-in/magic-link"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
            // `signaller://` is already in the server's trustedOrigins.
            "callbackURL": "signaller://auth",
        ])

        let (data, response) = try await send(request)
        try ensureSuccess(response, data: data)
    }

    /// Completes sign-in from a `signaller://auth?token=…` deep link.
    func completeMagicLink(token: String) async throws {
        var components = URLComponents(
            url: endpoint("/api/auth/magic-link/verify"),
            resolvingAgainstBaseURL: true
        )
        components?.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components?.url else { throw APIError.badURL }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (data, response) = try await send(request)
        try ensureSuccess(response, data: data)
        try captureToken(from: response)
    }

    // MARK: - Session

    func signOut() async {
        var request = URLRequest(url: endpoint("/api/auth/sign-out"))
        request.httpMethod = "POST"
        if let token = store.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // Clear locally regardless: a failed server call must not strand the
        // user in a signed-in-looking state they can't leave.
        _ = try? await send(request)
        store.signOut()
    }

    // MARK: - Plumbing

    private func endpoint(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL) ?? baseURL
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("Malformed response")
            }
            return (data, http)
        } catch let error as URLError {
            throw APIError.transport(error.localizedDescription)
        }
    }

    private func ensureSuccess(_ response: HTTPURLResponse, data: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        let envelope = try? JSONDecoder().decode(APIFailureEnvelope.self, from: data)
        throw APIError.http(status: response.statusCode, reason: envelope?.reason ?? envelope?.error)
    }

    private func captureToken(from response: HTTPURLResponse) throws {
        guard let token = response.value(forHTTPHeaderField: Self.tokenHeader), !token.isEmpty else {
            throw APIError.decoding("Sign-in succeeded but no session token was returned")
        }
        store.save(token: token)
    }

    // MARK: - base64url

    private func base64URL(_ data: Data?) -> String {
        guard let data else { return "" }
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func decodeBase64URL(_ value: String) throws -> Data {
        var s = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Restore the padding base64url strips.
        while s.count % 4 != 0 { s.append("=") }
        guard let data = Data(base64Encoded: s) else {
            throw APIError.decoding("Malformed challenge from server")
        }
        return data
    }
}

/// The subset of Better Auth's WebAuthn options the native flow needs.
private struct PasskeyOptions: Decodable {
    let challenge: String
    let rpId: String
}

/// Bridges `ASAuthorizationController`'s delegate callbacks to async/await.
private final class PasskeyPresenter: NSObject, ASAuthorizationControllerDelegate,
                                      ASAuthorizationControllerPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var continuation: CheckedContinuation<ASAuthorizationCredential, Error>?
    /// Held so ARC doesn't release the controller mid-flight.
    private var controller: ASAuthorizationController?

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    func perform(request: ASAuthorizationRequest) async throws -> ASAuthorizationCredential {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        continuation?.resume(returning: authorization.credential)
        continuation = nil
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}
