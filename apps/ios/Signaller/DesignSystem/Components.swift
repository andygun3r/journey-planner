import SwiftUI

/// Shared building blocks. Lifted out of the old single-file ContentView so
/// screens can be written independently of each other.

struct Card<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Palette.railNavy.opacity(0.08), radius: 12, x: 0, y: 4)
    }
}

/// Status as a pill. Always carries its own text, and a symbol as well when the
/// user has asked for stronger cues — colour alone is never the signal.
struct StatusPill: View {
    private let label: String
    private let tone: PillTone
    @Environment(\.strengthenCues) private var strengthenCues

    init(_ label: String, tone: PillTone) {
        self.label = label
        self.tone = tone
    }

    var body: some View {
        HStack(spacing: 4) {
            if strengthenCues {
                Image(systemName: tone.symbolName)
                    .font(.caption2.weight(.bold))
            }
            Text(label)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .foregroundStyle(tone.color)
        .background(tone.fillColor.opacity(tone == .neutral ? 0.12 : 0.10))
        .clipShape(Capsule())
        .accessibilityLabel(label)
    }
}

struct LabelText: View {
    private let value: String

    init(_ value: String) { self.value = value }

    var body: some View {
        Text(value.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(1.3)
            .foregroundStyle(Palette.inkMuted)
    }
}

struct NoticeCard: View {
    let title: String
    let message: String

    init(title: String, body: String) {
        self.title = title
        self.message = body
    }

    var body: some View {
        Card {
            Text(title).font(.title3.weight(.bold))
            Text(message).foregroundStyle(Palette.inkMuted)
        }
    }
}

/// Shown when a request succeeded but there was nothing to show.
///
/// This case used to render as a blank screen: the old code only displayed a
/// message when `ok` was false, so an `ok: true` with zero results said
/// nothing at all.
struct EmptyStateCard: View {
    let title: String
    let message: String
    var systemImage: String = "tram"
    var retry: (() -> Void)?

    var body: some View {
        Card {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .foregroundStyle(Palette.inkMuted)
                Text(title).font(.title3.weight(.bold))
            }
            Text(message).foregroundStyle(Palette.inkMuted)
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(SecondaryButtonStyle())
                    .padding(.top, 4)
            }
        }
    }
}

struct StatusRow: View {
    let label: String
    let ok: Bool?

    var body: some View {
        HStack {
            Text(label).font(.body.weight(.semibold))
            Spacer()
            StatusPill(
                ok == nil ? "Not checked" : ok == true ? "OK" : "Down",
                tone: ok == nil ? .neutral : ok == true ? .good : .bad
            )
        }
        .padding(.top, 8)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.white)
            // 48pt: comfortably past the 44pt minimum target size.
            .frame(minHeight: 48)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .background(Palette.railNavy.opacity(configuration.isPressed ? 0.88 : 1))
            .clipShape(Capsule())
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Palette.railNavy)
            .frame(minHeight: 46)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .background(Palette.railNavyTint.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(Capsule())
    }
}

/// Standard screen chrome: scrolling content on the platform background, with
/// the navy navigation bar.
struct AppChrome<Content: View>: View {
    private let title: String
    private let content: Content

    init(title: String = "Signaller", @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content
            }
            .padding(16)
        }
        .background(Palette.background)
        .navigationTitle(title)
        .toolbarBackground(Palette.railNavy, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        // The mark rides in the navigation bar's trailing corner: the brand is
        // present on every screen without a second header band eating vertical
        // space that belongs to departure times. Sized by height at the mark's
        // own 100:34 ratio — a square frame would letterbox it.
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                SignalMark()
                    .frame(width: 18 * (100.0 / 34.0), height: 18)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Whether to pair status colours with a symbol.
///
/// This defaulted to `false` and was never written by anything, so the symbol
/// branch in `StatusPill` was dead code in every shipping build — the feature
/// existed on paper only.
///
/// It now defaults to the system's own Differentiate Without Colour setting,
/// which costs nothing and is immediately correct for every user who has it on.
/// The account preference from `/api/settings/accessibility` is OR'd in on top
/// once that screen exists, so a user can opt in without the system toggle.
private struct StrengthenCuesKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var strengthenCues: Bool {
        get { self[StrengthenCuesKey.self] }
        set { self[StrengthenCuesKey.self] = newValue }
    }
}

/// Turns on non-colour status cues when the system asks for them.
///
/// Applied once at the root; reads `accessibilityDifferentiateWithoutColor`
/// there so every `StatusPill` beneath picks it up.
struct StrengthenCuesFromSystem: ViewModifier {
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiate

    func body(content: Content) -> some View {
        content.environment(\.strengthenCues, differentiate)
    }
}
