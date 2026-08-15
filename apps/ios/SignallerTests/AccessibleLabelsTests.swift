import Foundation
import Testing
@testable import Signaller

/// What VoiceOver actually says.
///
/// These are the sentences a blind commuter hears on a platform, so they're
/// tested like any other user-facing copy. The critical one is the platform
/// change: it was previously an unlabelled icon inside an unlabelled row, so
/// the board's most actionable signal was completely silent.
@Suite("Accessible labels")
struct AccessibleLabelsTests {
    /// Builds a departure from the real captured board, with overrides.
    private func departure(_ overrides: [String: Any?] = [:]) throws -> Departure {
        let object = try #require(
            try JSONSerialization.jsonObject(with: Fixtures.data("board")) as? [String: Any]
        )
        let board = try #require(object["board"] as? [String: Any])
        var row = try #require((board["departures"] as? [[String: Any]])?.first)
        for (key, value) in overrides {
            if let value { row[key] = value } else { row.removeValue(forKey: key) }
        }
        return try JSONDecoder.signaller.decode(
            Departure.self,
            from: try JSONSerialization.data(withJSONObject: row)
        )
    }

    @Test("a platform change is spoken, not left to an icon")
    func platformChangeIsSpoken() throws {
        let changed = try departure(["platform": "12", "platformChanged": true])
        let label = AccessibleLabels.departure(changed)
        #expect(label.contains("Platform 12"))
        // The whole point: the word, not just the amber triangle.
        #expect(label.lowercased().contains("changed"))

        let unchanged = try departure(["platform": "12", "platformChanged": false])
        #expect(!AccessibleLabels.departure(unchanged).lowercased().contains("changed"))
    }

    @Test("the label leads with time and destination")
    func leadsWithTheAnswer() throws {
        let row = try departure()
        let label = AccessibleLabels.departure(row)
        // "Confident and concise — lead with the answer" (brand voice).
        #expect(label.hasPrefix(row.effectiveTime.hhmm))
        #expect(label.contains(row.destinationName))
    }

    @Test("a retimed departure says what it was")
    func retimedSaysOriginalTime() throws {
        let row = try departure([
            "scheduled": "2026-08-15T07:27:00.000Z",
            "expected": "2026-08-15T07:31:00.000Z",
        ])
        guard row.isRetimed else { return }
        #expect(AccessibleLabels.departure(row).contains(row.scheduled.hhmm))
    }

    @Test("every departure label is a non-empty sentence")
    func neverEmpty() throws {
        // A row missing every optional field must still say something useful.
        let sparse = try departure([
            "platform": nil, "operator": nil, "coachCount": nil,
            "reason": nil, "position": nil,
        ])
        let label = AccessibleLabels.departure(sparse)
        #expect(!label.isEmpty)
        #expect(label.contains(sparse.destinationName))
    }

    // MARK: - Live trains

    private func train(_ json: String) throws -> LiveTrain {
        try JSONDecoder.signaller.decode(LiveTrain.self, from: Data(json.utf8))
    }

    @Test("a train marker says its status in words")
    func trainLabelCarriesStatus() throws {
        let late = try train(#"""
        {"id":"a","lat":51.5,"lon":-0.1,"headcode":"1A23","destName":"Brighton","latenessMinutes":12}
        """#)
        let label = AccessibleLabels.liveTrain(late)
        #expect(label.contains("1A23"))
        #expect(label.contains("Brighton"))
        // Colour alone carried this before — the marker was unlabelled.
        #expect(label.contains("12 min late"))
    }

    @Test("a train with no report says so rather than implying on time")
    func noReportIsNotOnTime() throws {
        let unknown = try train(#"{"id":"b","lat":51.5,"lon":-0.1}"#)
        let label = AccessibleLabels.liveTrain(unknown)
        #expect(label.contains("No report"))
        #expect(!label.contains("On time"))
    }

    @Test("a stale position states its age")
    func staleStatesAge() throws {
        let stale = try train(#"""
        {"id":"c","lat":51.5,"lon":-0.1,"latenessMinutes":0,"reportedAgoSeconds":1200}
        """#)
        #expect(stale.isStale)
        #expect(AccessibleLabels.liveTrain(stale).contains("ago"))
    }

    // MARK: - Calling points

    @Test("a calling point says where the train is relative to it")
    func callStateIsSpoken() {
        let here = AccessibleLabels.call(
            stationName: "Clapham Junction", time: "07:38", state: .current, platform: "12"
        )
        #expect(here.contains("Clapham Junction"))
        #expect(here.contains("here now"))
        #expect(here.contains("platform 12"))

        #expect(AccessibleLabels.call(
            stationName: "Woking", time: "07:55", state: .departed, platform: nil
        ).contains("departed"))

        #expect(AccessibleLabels.call(
            stationName: "Woking", time: "07:55", state: .cancelled, platform: nil
        ).contains("cancelled"))
    }

    @Test("every call state has distinct wording")
    func callStatesAreDistinct() {
        let phrases = [
            AccessibleLabels.CallState.departed,
            .current,
            .upcoming,
            .cancelled,
        ].map(\.spokenDescription)
        #expect(Set(phrases).count == phrases.count)
        #expect(phrases.allSatisfy { !$0.isEmpty })
    }
}
