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
                .activityBackgroundTint(Color(red: 0.11, green: 0.14, blue: 0.25))
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
            } compactTrailing: {
                Circle()
                    .fill(statusColor(context.state))
                    .frame(width: 8, height: 8)
            } minimal: {
                Circle()
                    .fill(statusColor(context.state))
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

private func statusColor(_ state: JourneyActivityAttributes.ContentState) -> Color {
    if let delay = state.delayMinutes, delay > 0 {
        return delay >= 10 ? Color(red: 0.84, green: 0.21, blue: 0.17) : Color(red: 0.63, green: 0.33, blue: 0.0)
    }
    return Color(red: 0.18, green: 0.49, blue: 0.27)
}

private func timeLabel(_ date: Date) -> String {
    date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
}
