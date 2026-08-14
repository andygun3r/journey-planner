import Foundation
import Observation
import Security

/// Holds the Better Auth session token.
///
/// Keychain rather than `HTTPCookieStorage`, for three reasons: cookies aren't
/// visible to the Live Activity extension, they're cleared at times outside the
/// app's control, and they make "am I signed in?" unanswerable without a
/// network round-trip. A token we hold explicitly answers that offline.
///
/// `kSecAttrAccessibleAfterFirstUnlock` so background refreshes and push
/// handling still work when the phone is locked.
@Observable
final class AuthStore {
    private static let service = "uk.signaller.app"
    private static let account = "better-auth-session-token"

    /// Set on load and kept in step with the Keychain, so views can branch on
    /// signed-in state without touching the Keychain on every render.
    private(set) var token: String?

    var isSignedIn: Bool { token != nil }

    init() {
        token = Self.readFromKeychain()
    }

    func save(token newToken: String) {
        let trimmed = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Self.writeToKeychain(trimmed)
        token = trimmed
    }

    func signOut() {
        Self.deleteFromKeychain()
        token = nil
    }

    // MARK: - Keychain

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func readFromKeychain() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty
        else { return nil }
        return value
    }

    private static func writeToKeychain(_ value: String) {
        let data = Data(value.utf8)
        // Update in place if present; SecItemAdd would fail with errSecDuplicateItem.
        let updated = SecItemUpdate(
            baseQuery() as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        guard updated != errSecSuccess else { return }

        var insert = baseQuery()
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }

    private static func deleteFromKeychain() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
