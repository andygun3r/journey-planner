import ActivityKit
import SwiftUI
import WidgetKit

@main
struct SignallerLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        SignallerLiveActivity()
    }
}

struct SignallerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JourneyActivityAttributes.self) { context in
            LockScreenLiveActivityView(context: context)
                .activityBackgroundTint(ActivityPalette.railNavy)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(timeLabel(context.state.eta))
                        .font(.system(.title2, design: .rounded).weight(.bold))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.status)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor(context.state))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.attributes.routeName)
                            .font(.caption.weight(.semibold))
                        Text("\(context.state.currentStop) to \(context.state.nextStop)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Text(timeLabel(context.state.eta))
                    .font(.caption.weight(.bold))
                    .accessibilityLabel("Arriving \(timeLabel(context.state.eta))")
            } compactTrailing: {
                // Was a bare coloured circle — status by colour alone, on the
                // surface the user actually sees most of the time. A delay
                // figure is both more useful and more accessible than a dot.
                compactStatus(context.state)
            } minimal: {
                Image(systemName: statusSymbol(context.state))
                    .foregroundStyle(statusColor(context.state))
                    .accessibilityLabel(statusPhrase(context.state))
            }
        }
    }
}

struct LockScreenLiveActivityView: View {
    let context: ActivityViewContext<JourneyActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Signaller")
                    .font(.headline.weight(.bold))
                Spacer()
                Text(context.state.status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor(context.state))
            }
            Text(context.attributes.routeName)
                .font(.title3.weight(.bold))
            HStack {
                VStack(alignment: .leading) {
                    Text("Now")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(context.state.currentStop)
                        .font(.caption.weight(.semibold))
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text("ETA")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(timeLabel(context.state.eta))
                        .font(.title2.weight(.bold))
                }
            }
        }
        .padding()
    }
}

/// Delay shown as a figure where there's room, so the compact presentation
/// carries information rather than a hue.
@ViewBuilder
private func compactStatus(_ state: JourneyActivityAttributes.ContentState) -> some View {
    if let delay = state.delayMinutes, delay != 0 {
        Text(delay > 0 ? "+\(delay)" : "\(delay)")
            .font(.caption.weight(.bold))
            .foregroundStyle(statusColor(state))
            .accessibilityLabel(statusPhrase(state))
    } else {
        Image(systemName: statusSymbol(state))
            .foregroundStyle(statusColor(state))
            .accessibilityLabel(statusPhrase(state))
    }
}

/// Shape as a second channel alongside colour.
private func statusSymbol(_ state: JourneyActivityAttributes.ContentState) -> String {
    guard let delay = state.delayMinutes, delay > 0 else { return "checkmark.circle.fill" }
    return delay >= 10 ? "exclamationmark.triangle.fill" : "exclamationmark.circle.fill"
}

/// The status in words, for VoiceOver.
private func statusPhrase(_ state: JourneyActivityAttributes.ContentState) -> String {
    guard let delay = state.delayMinutes, delay != 0 else { return "On time" }
    return delay > 0 ? "\(delay) minutes late" : "\(abs(delay)) minutes early"
}

/// Brand colours, matched to `Palette`.
///
/// These were hardcoded RGB triples that had already drifted from the brand
/// values (0.11/0.14/0.25 against Rail Navy's #1C2340), which meant the
/// extension bypassed the contrast tests entirely. The widget target can't see
/// `DesignSystem/`, so they're defined once here from the same hex values.
private enum ActivityPalette {
    static let railNavy = Color(red: 0x1C / 255, green: 0x23 / 255, blue: 0x40 / 255)
    static let signalRed = Color(red: 0xD6 / 255, green: 0x35 / 255, blue: 0x2C / 255)
    static let signalAmber = Color(red: 0xA0 / 255, green: 0x55 / 255, blue: 0x00 / 255)
    static let signalGreen = Color(red: 0x2E / 255, green: 0x7D / 255, blue: 0x46 / 255)
}

private func statusColor(_ state: JourneyActivityAttributes.ContentState) -> Color {
    if let delay = state.delayMinutes, delay > 0 {
        return delay >= 10 ? ActivityPalette.signalRed : ActivityPalette.signalAmber
    }
    return ActivityPalette.signalGreen
}

private func timeLabel(_ date: Date) -> String {
    date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
}
