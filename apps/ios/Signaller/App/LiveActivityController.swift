import ActivityKit
import Foundation
import Observation

/// Starts, updates and ends the journey Live Activity.
///
/// Activities are **app-driven**: `pushType` stays `nil` and the content state
/// is refreshed from the app's own live layer (see Phase 4's `LiveChannel`).
/// That means an activity stops updating once the app is terminated, which is
/// the accepted trade for not needing an APNs round-trip per update.
@Observable
@MainActor
final class LiveActivityController {
    private(set) var activeActivityID: String?
    var message: String?

    var activitiesAvailable: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    var hasActiveActivity: Bool { activeActivityID != nil }

    /// Begins tracking a journey on the Lock Screen and Dynamic Island.
    ///
    /// Refuses to start without a real arrival time. The previous version fell
    /// back to `Date() + 30 minutes` when the timestamp wouldn't parse, which
    /// put an invented ETA on the user's Lock Screen — the one thing a live
    /// rail product must never do. No data has to look like no data.
    func start(for journey: Journey) {
        guard activitiesAvailable else {
            message = "Live Activities are turned off for Signaller. You can enable them in Settings."
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
        let eta = journey.effectiveArrival
        let state = JourneyActivityAttributes.ContentState(
            status: Self.statusText(for: journey),
            currentStop: first.originName,
            nextStop: last.destName,
            eta: eta,
            delayMinutes: journey.delayMinutes
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                // Goes stale 15 min past arrival: after that the system dims it
                // rather than presenting old times as current.
                content: ActivityContent(state: state, staleDate: eta.addingTimeInterval(15 * 60)),
                pushType: nil
            )
            activeActivityID = activity.id
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    /// Pushes fresh live data into a running activity. Called from the service
    /// live stream while the app is running.
    func update(status: String, currentStop: String, nextStop: String?, eta: Date, delayMinutes: Int?) async {
        let state = JourneyActivityAttributes.ContentState(
            status: status,
            currentStop: currentStop,
            nextStop: nextStop ?? "",
            eta: eta,
            delayMinutes: delayMinutes
        )
        for activity in Activity<JourneyActivityAttributes>.activities where activity.id == activeActivityID {
            await activity.update(
                ActivityContent(state: state, staleDate: eta.addingTimeInterval(15 * 60))
            )
        }
    }

    /// Ends every running activity. Reachable from the journey detail screen —
    /// previously this existed but nothing called it, so an activity could only
    /// be dismissed from the Lock Screen.
    func endAll() async {
        for activity in Activity<JourneyActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        activeActivityID = nil
        message = nil
    }

    private static func statusText(for journey: Journey) -> String {
        if journey.status == .cancelled { return "Cancelled" }
        if let delay = journey.delayMinutes, delay > 0 { return "\(delay) min late" }
        return journey.status == .onTime ? "On time" : "Tracking"
    }
}
