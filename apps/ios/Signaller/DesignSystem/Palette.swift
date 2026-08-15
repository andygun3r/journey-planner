import SwiftUI

/// Signaller's colours, taken from the brand handoff in `data/design/`.
///
/// **Light-only by design** — see PRODUCT.md's One-Theme Rule. That is a
/// deliberate product decision, not an oversight, so the app *declares* it:
/// `UIUserInterfaceStyle = Light` in Info.plist and `.preferredColorScheme(.light)`
/// on the root scene. Without that declaration SwiftUI's default text colour
/// flips to white in Dark Mode while these hardcoded surfaces stay light, and
/// every unstyled label renders white-on-white.
///
/// Values are hex, not eyeballed RGB floats. The previous 2-decimal floats put
/// every single colour a point or two off brand (#1C2440 for Rail Navy's
/// #1C2340, and so on) — close enough to look right, wrong enough that no
/// colour in the app was actually the brand colour.
enum Palette {
    // MARK: - Brand

    /// #1C2340 — authority and structure: header band, primary buttons, primary text.
    static let railNavy = Color(hex: 0x1C2340)
    /// #14161F — pressed state of navy actions; the darkest surface.
    static let railNavyDeep = Color(hex: 0x14161F)
    /// #E7E8EE — light wash behind selected/secondary controls.
    static let railNavyTint = Color(hex: 0xE7E8EE)

    /// #D6352C — the one spotlight colour: live status, delays, urgent action.
    ///
    /// A **fill** colour: white text on it, or a tinted wash behind text. As
    /// red text it clears 4.5:1 on a white card (4.77:1) but not on the
    /// Platform White page ground (4.34:1) — use `signalRedText` for words.
    static let signalRed = Color(hex: 0xD6352C)
    /// #B23A2E — pressed state of red actions.
    static let signalRedDeep = Color(hex: 0xB23A2E)
    /// Red *text*, on either light ground.
    ///
    /// Signal Red itself fails AA on Platform White, and a delay that only
    /// just fails to be readable is worse than one rendered a shade darker —
    /// so anything word-shaped uses the deep variant (5.40:1 on the page
    /// ground, 5.94:1 on a card). The brand ships this variant already; this
    /// alias just names when it is mandatory rather than stylistic.
    static let signalRedText = signalRedDeep

    // MARK: - Neutrals

    /// #F6F4F0 — page ground. Breathing room, not stark white.
    static let platformWhite = Color(hex: 0xF6F4F0)
    /// #14161F — primary text on light surfaces.
    static let ink = Color(hex: 0x14161F)
    /// #4A4E5C — secondary text and labels. 7.5:1 on Platform White.
    static let inkMuted = Color(hex: 0x4A4E5C)
    /// rgba(20,22,31,0.08) — hairline rule inside cards.
    static let rule = Color(hex: 0x14161F).opacity(0.08)

    // MARK: - Live status

    /// #2E7D46 — on time / good service.
    static let signalGreen = Color(hex: 0x2E7D46)
    /// #26683A — green *text* on a near-white ground.
    ///
    /// The same trap `signalRedText` exists for. Signal Green clears AA on a
    /// white card (5.07:1) and on the page ground (4.62:1), but only just — and
    /// on the light pill ground used inside a `HeroCard` (#EDEDF0) it drops to
    /// **4.34:1 and fails**. This variant is 5.75:1 there and 6.72:1 on a card.
    static let signalGreenText = Color(hex: 0x26683A)
    /// #A05500 — minor delay. The darkened amber, not the brand's #E4B676:
    /// that lighter tone is a status *dot* colour and fails contrast as text.
    static let signalAmber = Color(hex: 0xA05500)

    // MARK: - Semantic aliases

    /// Card fill — floats on `background`.
    static let surface = Color.white
    /// Page ground.
    static let background = platformWhite
    /// Text on a navy surface.
    static let onNavy = Color.white
}

extension Color {
    /// Builds a colour from a hex literal so brand values stay verifiable
    /// against the handoff at a glance.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
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

    /// The colour this tone's *text* is drawn in.
    ///
    /// `.bad` uses the deep red rather than Signal Red: pill text sits on both
    /// white cards and the Platform White page ground, and Signal Red clears
    /// 4.5:1 only on the former.
    var color: Color {
        switch self {
        case .neutral: return Palette.railNavy
        case .good: return Palette.signalGreen
        case .warn: return Palette.signalAmber
        case .bad: return Palette.signalRedText
        }
    }

    /// The colour this tone's *fill* uses — the pill wash and status dots.
    /// Full-strength Signal Red keeps its spotlight job wherever it isn't text.
    var fillColor: Color {
        self == .bad ? Palette.signalRed : color
    }

    /// Text colour when the pill sits on a `HeroCard`'s navy ground.
    ///
    /// The pill there is a near-white capsule (#EDEDF0), which is darker than a
    /// card and enough to push Signal Green under 4.5:1 — so `.good` takes the
    /// deep variant. The others already clear AA and keep their usual colour.
    var onNavyColor: Color {
        self == .good ? Palette.signalGreenText : color
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
