import Foundation

/// Account-level accessibility preferences.
///
/// Mirrors `AccessibilityPrefsInput` in `packages/shared/src/accessibility.ts`.
/// These sit *alongside* the system's own settings rather than replacing them:
/// iOS's Dynamic Type and Differentiate Without Colour are separate signals,
/// and both have to be honoured — the route's own comment says so.
struct AccessibilityPrefs: Codable, Equatable {
    var reducedMotion: Bool
    var textSize: TextSize
    var highContrast: Bool
    /// Pair status colours with a symbol.
    var strengthenCues: Bool

    /// Exactly the values `TextSize` accepts in
    /// `packages/shared/src/accessibility.ts` — the route zod-parses this, so
    /// a wrong spelling is a 400, not a silent default.
    enum TextSize: String, Codable, CaseIterable {
        case normal
        case large
        case larger

        var label: String {
            switch self {
            case .normal: return "Normal"
            case .large: return "Large"
            case .larger: return "Larger"
            }
        }
    }

    static let `default` = AccessibilityPrefs(
        reducedMotion: false,
        textSize: .normal,
        highContrast: false,
        strengthenCues: false
    )
}

struct AccessibilityPrefsResponse: Codable {
    let ok: Bool
    let prefs: AccessibilityPrefs
}

/// Which categories of push notification the account wants.
///
/// Mirrors `PushPreferences` in `apps/web/lib/push.ts`. Separate from the OS
/// permission: the system switch decides whether notifications can arrive at
/// all, these decide which ones are worth sending.
struct PushPreferences: Codable, Equatable {
    var commuteDisruptions: Bool
    var preDeparture: Bool
    var networkDisruptions: Bool

    static let `default` = PushPreferences(
        commuteDisruptions: true,
        preDeparture: false,
        networkDisruptions: false
    )
}
