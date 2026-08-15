import SwiftUI

/// The full journey: every leg, in order, with changes called out.
///
/// The app had no detail screen at all before this — three tabs, no
/// `NavigationLink` anywhere — so a journey with four legs could only ever be
/// seen three legs at a time.
struct JourneyDetailView: View {
    let journey: Journey
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Journey") {
            summaryCard
            legsCard
            liveActivityCard
        }
    }

    private var summaryCard: some View {
        Card {
            HStack(alignment: .firstTextBaseline) {
                Text(journey.effectiveDeparture.hhmm)
                    .font(.largeTitle.weight(.bold))
                    .monospacedDigit()
                Image(systemName: "arrow.right").foregroundStyle(Palette.inkMuted)
                Text(journey.effectiveArrival.hhmm)
                    .font(.largeTitle.weight(.bold))
                    .monospacedDigit()
                Spacer()
            }
            // Without this VoiceOver reads "07:31, 09:14" with no relationship
            // between the two — the arrow carries it visually and says nothing.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "Departs \(journey.effectiveDeparture.hhmm), arrives \(journey.effectiveArrival.hhmm)"
            )
            HStack {
                StatusPill(
                    StatusFormatting.journeyLabel(
                        status: journey.status,
                        delayMinutes: journey.delayMinutes
                    ),
                    tone: StatusFormatting.journeyTone(status: journey.status)
                )
                if let countdown = StatusFormatting.countdown(to: journey.effectiveDeparture) {
                    Text(countdown).font(.callout).foregroundStyle(Palette.inkMuted)
                }
            }
            if let note = journey.destinationWalkNote {
                Text(note).font(.callout).foregroundStyle(Palette.inkMuted)
            }
        }
    }

    private var legsCard: some View {
        Card {
            LabelText("Every leg")
            // All of them — no prefix, no truncation.
            ForEach(Array(journey.legs.enumerated()), id: \.element.id) { index, leg in
                if index > 0 {
                    changeRow(from: journey.legs[index - 1], to: leg)
                }
                LegDetailRow(leg: leg)
            }
        }
    }

    /// The gap between two legs: how long you have, and whether you can stay put.
    private func changeRow(from previous: JourneyLeg, to next: JourneyLeg) -> some View {
        let minutes = Int(next.departs.timeIntervalSince(previous.arrives) / 60)
        return HStack(spacing: 8) {
            // The adjacent text already says "Stay on board" or "Change at…",
            // so labelling this icon too would just make VoiceOver repeat itself.
            Image(systemName: next.staySeated ? "person.fill.checkmark" : "arrow.triangle.swap")
                .font(.caption)
                .foregroundStyle(Palette.inkMuted)
                .frame(width: 16)
                .accessibilityHidden(true)
            Text(next.staySeated
                 ? "Stay on board · \(minutes) min"
                 : "Change at \(previous.destName) · \(minutes) min")
                .font(.caption.weight(.semibold))
                .foregroundStyle(minutes < 5 ? Palette.signalAmber : Palette.inkMuted)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var liveActivityCard: some View {
        Card {
            LabelText("Live Activity")
            Text("Track this journey on your Lock Screen.")
                .font(.callout)
                .foregroundStyle(Palette.inkMuted)

            if env.liveActivities.hasActiveActivity {
                // Previously unreachable: `endAll()` existed but no view called
                // it, so a started activity could only be swiped away.
                Button("Stop tracking") {
                    Task { await env.liveActivities.endAll() }
                }
                .buttonStyle(SecondaryButtonStyle())
            } else {
                Button("Track this journey") {
                    env.liveActivities.start(for: journey)
                }
                .buttonStyle(PrimaryButtonStyle())
            }

            if let message = env.liveActivities.message {
                Text(message).font(.caption).foregroundStyle(Palette.signalAmber)
            }
        }
    }
}

private struct LegDetailRow: View {
    let leg: JourneyLeg

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: leg.isWalk ? "figure.walk" : "tram.fill")
                .font(.body)
                .foregroundStyle(leg.cancelled ? Palette.signalRed : Palette.railNavy)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(leg.departs.hhmm).font(.body.weight(.semibold)).monospacedDigit()
                    Text(leg.originName).font(.body.weight(.semibold)).lineLimit(1)
                }
                HStack(spacing: 6) {
                    Text(leg.arrives.hhmm).font(.callout).monospacedDigit()
                    Text(leg.destName).font(.callout).lineLimit(1)
                }
                .foregroundStyle(Palette.inkMuted)

                if let label = leg.modeLabel {
                    Text(detailLine(label)).font(.caption).foregroundStyle(Palette.inkMuted)
                } else if leg.isWalk, let metres = leg.distanceMeters {
                    Text("Walk \(Int(metres.rounded())) m").font(.caption).foregroundStyle(Palette.inkMuted)
                }

                if leg.cancelled {
                    StatusPill("Cancelled", tone: .bad)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private func detailLine(_ label: String) -> String {
        // callCount counts the stops on the leg; "3 stops" is more useful than
        // the raw number on its own.
        guard leg.callCount > 0 else { return label }
        let stops = leg.callCount == 1 ? "1 stop" : "\(leg.callCount) stops"
        return "\(label) · \(stops)"
    }
}
