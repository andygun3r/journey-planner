import Foundation
import Testing
@testable import Signaller

/// The words the user actually reads. Pure functions, and the easiest thing in
/// the app to get subtly and invisibly wrong.
@Suite("Status wording")
struct StatusFormattingTests {
    @Test("cancelled beats every other signal")
    func cancelledWins() {
        // Even with a delay figure attached, a cancelled train is cancelled.
        #expect(StatusFormatting.journeyLabel(status: .cancelled, delayMinutes: 12) == "Cancelled")
        #expect(StatusFormatting.journeyTone(status: .cancelled) == .bad)
    }

    @Test("lateness is reported in both directions")
    func lateAndEarly() {
        #expect(StatusFormatting.journeyLabel(status: .delayed, delayMinutes: 7) == "7 min late")
        // Running early is real and worth saying — not "on time".
        #expect(StatusFormatting.journeyLabel(status: .onTime, delayMinutes: -3) == "3 min early")
        #expect(StatusFormatting.journeyLabel(status: .onTime, delayMinutes: 0) == "On time")
    }

    @Test("a board row with no live data reads Scheduled, not On time")
    func scheduledWithoutLive() {
        // The board must not imply a confirmation it hasn't received.
        #expect(
            StatusFormatting.departureLabel(status: .scheduled, delayMinutes: nil, hasLive: false)
                == "Scheduled"
        )
        #expect(
            StatusFormatting.departureLabel(status: .scheduled, delayMinutes: nil, hasLive: true)
                == "Expected"
        )
        #expect(StatusFormatting.departureTone(status: .scheduled, hasLive: false) == .neutral)
    }

    @Test("an unknown status degrades rather than failing")
    func unknownStatus() {
        #expect(StatusFormatting.journeyLabel(status: .unknown, delayMinutes: nil) == "Scheduled")
        #expect(StatusFormatting.journeyTone(status: .unknown) == .neutral)
    }

    @Test("countdown returns nil once a departure has gone")
    func countdownPast() {
        let now = Date()
        // A negative countdown isn't information, it's noise.
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(-120), now: now) == nil)
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(30), now: now) == "now")
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(60), now: now) == "in 1 min")
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(600), now: now) == "in 10 min")
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(3600), now: now) == "in 1h")
        #expect(StatusFormatting.countdown(to: now.addingTimeInterval(5400), now: now) == "in 1h 30m")
    }

    @Test("report age is spelled out so staleness is never implied to be current")
    func reportedAgo() {
        #expect(StatusFormatting.reportedAgo(seconds: 20) == "reported just now")
        #expect(StatusFormatting.reportedAgo(seconds: 60) == "reported 1 min ago")
        #expect(StatusFormatting.reportedAgo(seconds: 600) == "reported 10 min ago")
        #expect(StatusFormatting.reportedAgo(seconds: 3600) == "reported 1 hour ago")
    }

    @Test("failure reasons map to actionable wording, not raw codes")
    func failureReasons() {
        #expect(StatusFormatting.planFailureTitle(reason: "engine-offline") == "Routing is offline")
        #expect(StatusFormatting.planFailureTitle(reason: "no-journeys") == "No journeys found")
        #expect(StatusFormatting.boardFailureTitle(reason: "unknown-station") == "Unknown station")
        // An unrecognised code still says something useful.
        #expect(!StatusFormatting.planFailureTitle(reason: "wat").isEmpty)
        #expect(!StatusFormatting.planFailureMessage(reason: nil).isEmpty)
    }
}

@Suite("API errors")
struct APIErrorTests {
    @Test("only transient failures offer a retry")
    func retryability() {
        #expect(APIError.transport("offline").isRetryable)
        #expect(APIError.http(status: 503, reason: "engine-offline").isRetryable)
        #expect(APIError.http(status: 429, reason: nil).isRetryable)
        // Retrying these can never help.
        #expect(!APIError.http(status: 400, reason: "bad-request").isRetryable)
        #expect(!APIError.unauthorized.isRetryable)
        #expect(!APIError.badURL.isRetryable)
    }

    @Test("backend reason codes become sentences")
    func reasonMessages() {
        let offline = APIError.http(status: 503, reason: "engine-offline")
        #expect(offline.errorDescription?.contains("routing engine") == true)
        let unknown = APIError.http(status: 400, reason: "unknown-station")
        #expect(unknown.errorDescription?.contains("station") == true)
        // A 500 with no reason still reads as a server problem, not user error.
        #expect(APIError.http(status: 500, reason: nil).errorDescription?.isEmpty == false)
    }
}
