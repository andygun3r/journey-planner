import SwiftUI

/// One journey in the results list.
///
/// Shows at most three legs — but says so. The old version silently dropped
/// leg four onwards, so a four-change journey looked like a three-change one.
struct JourneyRow: View {
    let journey: Journey

    private static let previewLegLimit = 3

    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline) {
                Text(journey.effectiveDeparture.hhmm)
                    .font(.largeTitle.weight(.bold))
                    .monospacedDigit()

                if journey.departureIsRetimed {
                    // Booked time struck through, so a retimed train reads as
                    // changed rather than just late.
                    Text(journey.departs.hhmm)
                        .font(.callout)
                        .monospacedDigit()
                        .strikethrough()
                        .foregroundStyle(Palette.inkMuted)
                }

                Spacer()
                StatusPill(
                    StatusFormatting.journeyLabel(
                        status: journey.status,
                        delayMinutes: journey.delayMinutes
                    ),
                    tone: StatusFormatting.journeyTone(status: journey.status)
                )
            }

            Text("Arrives \(journey.effectiveArrival.hhmm)")
                .font(.body.weight(.medium))
                .monospacedDigit()

            Text(summaryLine)
                .font(.callout)
                .foregroundStyle(Palette.inkMuted)

            Divider()

            ForEach(journey.legs.prefix(Self.previewLegLimit)) { leg in
                legLine(leg)
            }

            if journey.legs.count > Self.previewLegLimit {
                Text("+\(journey.legs.count - Self.previewLegLimit) more legs")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.railNavy)
            }

            if let note = journey.destinationWalkNote {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(Palette.inkMuted)
            }
        }
    }

    private func legLine(_ leg: JourneyLeg) -> some View {
        HStack(spacing: 8) {
            Image(systemName: leg.isWalk ? "figure.walk" : "tram.fill")
                .font(.caption)
                .foregroundStyle(Palette.inkMuted)
                .frame(width: 16)
            Text("\(leg.departs.hhmm) \(leg.originName) to \(leg.destName)")
                .font(.callout)
                .monospacedDigit()
                .strikethrough(leg.cancelled)
                .foregroundStyle(leg.cancelled ? Palette.signalRed : Palette.ink)
            Spacer(minLength: 0)
        }
    }

    private var summaryLine: String {
        let duration = journey.durationMinutes
        let hours = duration / 60
        let minutes = duration % 60
        let time = hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
        let changes = journey.changes == 0
            ? "Direct"
            : journey.changes == 1 ? "1 change" : "\(journey.changes) changes"
        return "\(time) · \(changes)"
    }
}
