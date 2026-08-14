import SwiftUI

/// Signaller's colours. Light-only by design — see PRODUCT.md's one-theme rule.
/// These match the web app's Platform White palette.
enum Palette {
    static let railNavy = Color(red: 0.11, green: 0.14, blue: 0.25)
    static let railNavyTint = Color(red: 0.91, green: 0.91, blue: 0.94)
    static let signalRed = Color(red: 0.84, green: 0.21, blue: 0.17)
    static let signalAmber = Color(red: 0.63, green: 0.33, blue: 0.0)
    static let signalGreen = Color(red: 0.18, green: 0.49, blue: 0.27)
    static let platformWhite = Color(red: 0.96, green: 0.96, blue: 0.94)
    static let inkMuted = Color(red: 0.29, green: 0.31, blue: 0.36)

    /// Semantic aliases, so views name the role rather than the colour.
    static let surface = Color.white
    static let background = platformWhite
    static let ink = railNavy
}

/// How a status reads at a glance.
///
/// Tone drives colour, but colour never carries the meaning alone — every
/// `StatusPill` also shows text, and `strengthenCues` adds a symbol. WCAG 2.2
/// AA, and a requirement in PRODUCT.md: status is never colour-only.
enum PillTone {
    case neutral
    case good
    case warn
    case bad

    var color: Color {
        switch self {
        case .neutral: return Palette.railNavy
        case .good: return Palette.signalGreen
        case .warn: return Palette.signalAmber
        case .bad: return Palette.signalRed
        }
    }

    /// A shape cue to pair with the colour, for anyone who can't rely on hue.
    var symbolName: String {
        switch self {
        case .neutral: return "clock"
        case .good: return "checkmark.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .bad: return "xmark.octagon.fill"
        }
    }
}
