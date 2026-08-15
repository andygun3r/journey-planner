import SwiftUI

/// Shared building blocks. Lifted out of the old single-file ContentView so
/// screens can be written independently of each other.

struct Card<Content: View>: View {
    private let content: Content
    private let spacing: CGFloat
    private let padding: CGFloat

    init(@ViewBuilder content: () -> Content) {
        self.init(spacing: 10, padding: 16, content: content)
    }

    /// `padding: 0` for a card that holds a list of rows: the rows carry their
    /// own insets so their hairline rules can run the full width of the card
    /// instead of stopping short on both sides.
    init(spacing: CGFloat = 10, padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Palette.railNavy.opacity(0.08), radius: 12, x: 0, y: 4)
    }
}

/// The most important thing on the screen, and only that.
///
/// Every container in this app used to be `Card` — 49 of them, all with the same
/// 18pt radius and the same navy-8% shadow, so a cancelled train and a Sign-out
/// button carried identical weight. DESIGN.md asks for the opposite: a full Rail
/// Navy card with a display-scale figure for the next departure, and a rule that
/// the spotlight lights "at most one thing per screen".
///
/// One `HeroCard` per screen. If a second one appears, something else should
/// have been a `Card`.
struct HeroCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.railNavy)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        // A heavier shadow than `Card`: this sits above the list, not in it.
        .shadow(color: Palette.railNavy.opacity(0.22), radius: 16, x: 0, y: 6)
        // Everything inside is on navy, so the default ink would be unreadable.
        .foregroundStyle(Palette.onNavy)
        .environment(\.onDarkGround, true)
    }
}

/// A list row: no fill, no shadow, one hairline.
///
/// The third level of the hierarchy. List items — departures, calling points,
/// alerts, settings entries — were each their own shadowed card, which is what
/// made every list in the app three times taller than it needed to be.
struct RowDivider: View {
    var body: some View {
        Rectangle()
            .fill(Palette.rule)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// A tappable row with a chevron.
///
/// There were three near-identical versions of this — `AccountView.row`,
/// `CommuteView.planningRow` and an inline one in `SignInView` — at 44, 48 and
/// 44pt, so the same control was a different height depending on which screen
/// you were on.
struct NavRow: View {
    let title: String
    var detail: String?
    var systemImage: String?

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage)
                    .foregroundStyle(Palette.railNavy)
                    .frame(width: 24)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(Palette.ink)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(Palette.inkMuted)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.inkMuted)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}

/// True when the surrounding surface is Rail Navy rather than a white card.
///
/// `StatusPill` reads this: its tinted-wash background is designed against
/// white and disappears on navy, where the pill needs a solid light ground to
/// stay legible.
private struct OnDarkGroundKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var onDarkGround: Bool {
        get { self[OnDarkGroundKey.self] }
        set { self[OnDarkGroundKey.self] = newValue }
    }
}

/// Status as a pill. Always carries its own text, and a symbol as well when the
/// user has asked for stronger cues — colour alone is never the signal.
struct StatusPill: View {
    private let label: String
    private let tone: PillTone
    @Environment(\.strengthenCues) private var strengthenCues
    @Environment(\.onDarkGround) private var onDarkGround

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
        .foregroundStyle(onDarkGround ? tone.onNavyColor : tone.color)
        .background(background)
        .clipShape(Capsule())
        .accessibilityLabel(label)
    }

    /// On a white card the pill is a 10–12% tint of its own colour. On navy
    /// that tint is invisible, so the pill switches to a solid light ground and
    /// takes its darkened text colour with it — the same contrast maths, on the
    /// other side.
    @ViewBuilder
    private var background: some View {
        if onDarkGround {
            Capsule().fill(Palette.onNavy.opacity(0.92))
        } else {
            tone.fillColor.opacity(tone == .neutral ? 0.12 : 0.10)
        }
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
    private let lazy: Bool
    private let content: Content

    /// `lazy: true` for screens with an unbounded list — alerts, a board's
    /// departures, a service's calling points. Those built every row eagerly,
    /// including offscreen ones, each a `Card` with its own shadow.
    ///
    /// Opt-in rather than the default: `LazyVStack` changes when `onAppear`
    /// fires on children, which fixed-size screens don't need and shouldn't
    /// have to think about.
    init(title: String = "Signaller", lazy: Bool = false, @ViewBuilder content: () -> Content) {
        self.title = title
        self.lazy = lazy
        self.content = content()
    }

    var body: some View {
        ScrollView {
            Group {
                if lazy {
                    LazyVStack(alignment: .leading, spacing: 16) { content }
                } else {
                    VStack(alignment: .leading, spacing: 16) { content }
                }
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
