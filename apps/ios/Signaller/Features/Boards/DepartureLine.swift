import SwiftUI

/// One departure, as a line on a board rather than a card.
///
/// This replaces `DepartureRow`, which was a 150–190pt shadowed `Card`. Three of
/// those filled the screen, on the one surface where PRODUCT.md asks for the
/// opposite: "commuters want many trains visible at once; achieve density
/// through tabular alignment and consistent rhythm, never clutter."
///
/// So: no card, no shadow, no fill. A hairline rule and four aligned columns —
/// time, destination, platform, status — sized so the numbers stack into
/// scannable columns instead of drifting with the text beside them.
struct DepartureLine: View {
    let departure: Departure
    let isExpanded: Bool
    let onTap: () -> Void

    /// Fixed column widths, so platform numbers line up down the board.
    /// A ragged right edge is what makes a list of times hard to scan.
    private enum Column {
        static let time: CGFloat = 58
        static let platform: CGFloat = 38
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onTap) {
                summary
            }
            .buttonStyle(.plain)

            if isExpanded {
                details
            }
        }
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        // One VoiceOver stop per departure. The label already names the
        // platform change, the delay reason and the live position, so the
        // expanded state adds no new information to speak — it only saves a
        // sighted user a tap.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(AccessibleLabels.departure(departure))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(isExpanded ? "Collapse" : "Show operator and live position")
        .accessibilityAction(named: "Full service details") { onTap() }
    }

    // MARK: - The line itself

    private var summary: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            timeColumn

            Text(departure.destinationName)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            platformColumn

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
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }

    /// Expected time, with the booked time beneath it when they differ.
    ///
    /// `DepartureRow` put the struck-through original *beside* the new time,
    /// which on a single line pushes the destination around and breaks the
    /// column. Stacked, the times stay in their column and the row keeps its
    /// rhythm whether or not a train is retimed.
    private var timeColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(departure.effectiveTime.hhmm)
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Palette.ink)

            if departure.isRetimed {
                Text(departure.scheduled.hhmm)
                    .font(.caption2)
                    .monospacedDigit()
                    .strikethrough()
                    .foregroundStyle(Palette.inkMuted)
            }
        }
        .frame(width: Column.time, alignment: .leading)
    }

    @ViewBuilder
    private var platformColumn: some View {
        if let platform = departure.platform {
            HStack(spacing: 2) {
                // A platform change is the single most actionable thing on a
                // board, so it keeps its symbol even at this density — the
                // row's spoken label says "changed" in words.
                if departure.platformChanged {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .accessibilityHidden(true)
                }
                Text(platform)
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .foregroundStyle(departure.platformChanged ? Palette.signalAmber : Palette.ink)
            .frame(width: Column.platform, alignment: .trailing)
        } else {
            // Hold the column even with no platform, so the ones that do have
            // a number stay in line.
            Color.clear.frame(width: Column.platform, height: 1)
        }
    }

    // MARK: - Expanded

    /// The fields the card version showed all the time. They're worth a tap,
    /// not a permanent third of the screen.
    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let operatorName = departure.operatorName {
                detailLine("tram.fill", operatorName + coachSuffix)
            } else if let count = departure.coachCount {
                detailLine("tram.fill", "\(count) coaches")
            }

            if let reason = departure.reason {
                detailLine("exclamationmark.circle", reason, tone: Palette.signalAmber)
            }

            if let position = departure.position {
                positionLine(position)
            }

            NavigationLink(value: departure) {
                HStack(spacing: 4) {
                    Text("Full service details")
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.railNavy)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, Column.time + 10)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var coachSuffix: String {
        guard let count = departure.coachCount else { return "" }
        return " · \(count) coaches"
    }

    private func detailLine(
        _ symbol: String,
        _ text: String,
        tone: Color = Palette.inkMuted
    ) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: symbol)
                .font(.caption2)
                .accessibilityHidden(true)
            Text(text)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(tone)
    }

    /// Where the train physically is, and how fresh that is. A stale report is
    /// still shown — a quiet feed is not a vanished train — but its age is
    /// stated rather than implied.
    private func positionLine(_ position: BoardPosition) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "location.fill")
                .font(.caption2)
                .accessibilityHidden(true)
            Text(position.label).font(.caption)
            if position.stale == true, let ago = position.reportedAgoSeconds {
                Text("· \(StatusFormatting.reportedAgo(seconds: ago))").font(.caption2)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(position.stale == true ? Palette.inkMuted : Palette.signalGreen)
    }
}
