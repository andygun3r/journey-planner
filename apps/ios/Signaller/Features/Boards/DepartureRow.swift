import SwiftUI

/// One row of the departure board.
///
/// Surfaces the fields the old client decoded away: platform changes, delay
/// reasons, coach counts and the live Network Rail position.
struct DepartureRow: View {
    let departure: Departure

    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(departure.effectiveTime.hhmm)
                    .font(.title.weight(.bold))
                    .monospacedDigit()

                if departure.isRetimed {
                    Text(departure.scheduled.hhmm)
                        .font(.caption)
                        .monospacedDigit()
                        .strikethrough()
                        .foregroundStyle(Palette.inkMuted)
                }

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

            Text(departure.destinationName)
                .font(.title3.weight(.semibold))
                .lineLimit(1)

            HStack(spacing: 10) {
                if let platform = departure.platform {
                    HStack(spacing: 3) {
                        Text("Plat \(platform)").font(.callout.weight(.semibold))
                        // A platform change is the single most actionable thing
                        // on a board — never leave it to colour alone.
                        if departure.platformChanged {
                            Image(systemName: "exclamationmark.triangle.fill").font(.caption2)
                        }
                    }
                    .foregroundStyle(departure.platformChanged ? Palette.signalAmber : Palette.ink)
                }
                if let operatorName = departure.operatorName {
                    Text(operatorName).font(.caption).foregroundStyle(Palette.inkMuted).lineLimit(1)
                }
                if let count = departure.coachCount {
                    Text("\(count) coaches").font(.caption).foregroundStyle(Palette.inkMuted)
                }
                Spacer(minLength: 0)
            }

            if let reason = departure.reason {
                Text(reason).font(.caption).foregroundStyle(Palette.signalAmber)
            }

            if let position = departure.position {
                positionLine(position)
            }
        }
    }

    /// Where the train physically is, and how fresh that is.
    private func positionLine(_ position: BoardPosition) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "location.fill").font(.caption2)
            Text(position.label).font(.caption)
            // A stale report is still shown — a quiet feed is not a vanished
            // train — but its age has to be said, not implied.
            if position.stale == true, let ago = position.reportedAgoSeconds {
                Text("· \(StatusFormatting.reportedAgo(seconds: ago))").font(.caption2)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(position.stale == true ? Palette.inkMuted : Palette.signalGreen)
    }
}
