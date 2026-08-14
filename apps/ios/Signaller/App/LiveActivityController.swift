import ActivityKit
import Foundation

@MainActor
final class LiveActivityController: ObservableObject {
    @Published var activeActivityID: String?
    @Published var message: String?

    var activitiesAvailable: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func startPreview(for journey: Journey) {
        guard activitiesAvailable else {
            message = "Live Activities are disabled on this device."
            return
        }
        guard let first = journey.legs.first, let last = journey.legs.last else {
            message = "This journey has no legs to track."
            return
        }

        let attributes = JourneyActivityAttributes(
            routeName: "\(first.originName) to \(last.destName)",
            trainUID: nil
        )
        let eta = ISO8601DateFormatter().date(from: journey.liveArrives ?? journey.arrives) ?? Date().addingTimeInterval(30 * 60)
        let state = JourneyActivityAttributes.ContentState(
            status: journey.delayMinutes.map { "\($0) min late" } ?? (journey.status == "on-time" ? "On time" : "Tracking"),
            currentStop: first.originName,
            nextStop: last.destName,
            eta: eta,
            delayMinutes: journey.delayMinutes
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: eta.addingTimeInterval(15 * 60)),
                pushType: nil
            )
            activeActivityID = activity.id
            message = "Live Activity started."
        } catch {
            message = error.localizedDescription
        }
    }

    func endAll() async {
        for activity in Activity<JourneyActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        activeActivityID = nil
        message = "Live Activities ended."
    }
}
