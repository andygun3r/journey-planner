import SwiftUI

/// The next train, answered without reading a list.
///
/// PRODUCT.md's primary scene is "one-handed, at 7am, glanceable in seconds and
/// readable at arm's length in poor light", and DESIGN.md specifies exactly this
/// component: a full Rail Navy card with a display-scale white time. The board
/// had no such thing — the next departure was simply the first of N identical
/// cards, so answering "what am I catching" meant reading rather than glancing.
struct NextDepartureHero: View {
    let departure: Departure
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HeroCard {
                HStack(alignment: .firstTextBaseline) {
                    LabelText("Next departure")
                        .foregroundStyle(Palette.onNavy.opacity(0.75))
                    Spacer()
                    StatusPill(
                        StatusFormatting.departureLabel(
                            status: departure.status,
                            delayMinutes: departure.delayMinutes,
                            hasLive: departure.hasLive
                        ),
                        tone: StatusFormatting.departureTone(
                            status: departure.status,
                            hasLive: departure.hasLive
                        )
                    )
                }

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(departure.effectiveTime.hhmm)
                        .font(.system(size: 46, weight: .heavy))
                        .monospacedDigit()

                    if departure.isRetimed {
                        Text(departure.scheduled.hhmm)
                            .font(.callout)
                            .monospacedDigit()
                            .strikethrough()
                            .foregroundStyle(Palette.onNavy.opacity(0.7))
                    }

                    Spacer(minLength: 0)

                    if let countdown = StatusFormatting.countdown(to: departure.effectiveTime) {
                        Text(countdown)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Palette.onNavy.opacity(0.85))
                    }
                }

                Text(departure.destinationName)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)

                platformLine
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Next departure. " + AccessibleLabels.departure(departure))
        .accessibilityAddTraits(.isButton)
    }

    /// Platform gets its own line at full size — on a platform at 7am it is
    /// half the answer, and it was previously a `.callout` sharing a row with
    /// the operator name and the coach count.
    private var platformLine: some View {
        HStack(spacing: 8) {
            if let platform = departure.platform {
                HStack(spacing: 4) {
                    if departure.platformChanged {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .accessibilityHidden(true)
                    }
                    Text(departure.platformChanged
                        ? "Platform \(platform) — changed"
                        : "Platform \(platform)")
                        .font(.body.weight(.semibold))
                }
                // Amber on navy is the one place the warning tone would fail
                // contrast, so a changed platform goes white and says the word
                // "changed" instead of relying on colour.
                .foregroundStyle(Palette.onNavy)
            } else {
                Text("Platform not given")
                    .font(.body)
                    .foregroundStyle(Palette.onNavy.opacity(0.75))
            }

            Spacer(minLength: 0)

            if let operatorName = departure.operatorName {
                Text(operatorName)
                    .font(.caption)
                    .foregroundStyle(Palette.onNavy.opacity(0.75))
                    .lineLimit(1)
            }
        }
    }
}
