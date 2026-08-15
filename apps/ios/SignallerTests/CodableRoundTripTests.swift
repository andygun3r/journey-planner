import Foundation
import Testing
@testable import Signaller

/// Every model survives a trip to disk and back.
///
/// The models were `Decodable`-only, which is what made any persistence
/// impossible. Now that they encode too, a cached response has to come back as
/// exactly what the server sent — otherwise the offline layer silently serves
/// a degraded copy, which is worse than serving nothing.
///
/// These run against the real captured fixtures, so they also catch the case
/// where a hand-written `encode(to:)` drifts from its `init(from:)`.
@Suite("Codable round trip")
struct CodableRoundTripTests {
    /// decode → encode → decode → encode, and the two encodings must match.
    ///
    /// Compares the *re-encoded JSON* rather than the values, because the
    /// response wrappers aren't `Equatable` and adding that conformance to
    /// production types purely to satisfy a test is the wrong trade. If the
    /// second encoding matches the first, nothing was lost in between.
    private func roundTrip<T: Codable>(_ name: String, as type: T.Type) throws {
        // A local encoder, not the shared `JSONEncoder.signaller`: that one is
        // a `static let` used app-wide, and mutating its `outputFormatting`
        // here would leak into every other test.
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = JSONEncoder.signaller.dateEncodingStrategy
        encoder.outputFormatting = [.sortedKeys]

        let original = try Fixtures.load(name, as: type)
        let first = try encoder.encode(original)
        let second = try encoder.encode(try JSONDecoder.signaller.decode(type, from: first))

        #expect(
            first == second,
            """
            \(name) did not survive the round trip.
            first:  \(String(decoding: first, as: UTF8.self).prefix(400))
            second: \(String(decoding: second, as: UTF8.self).prefix(400))
            """
        )
    }

    @Test("board")
    func board() throws {
        try roundTrip("board", as: BoardResponse.self)
    }

    @Test("service")
    func service() throws {
        try roundTrip("service", as: ServiceResponse.self)
    }

    @Test("alerts")
    func alerts() throws {
        try roundTrip("alerts", as: AlertsResponse.self)
    }

    @Test("live trains snapshot")
    func liveTrains() throws {
        try roundTrip("live-trains-snapshot", as: LiveTrainsSnapshot.self)
    }

    @Test("stations")
    func stations() throws {
        try roundTrip("stations", as: StationSearchResponse.self)
    }

    /// The discriminated union — the one most likely to break.
    ///
    /// `DashboardState` decodes on a `kind` field and merges the payload into
    /// the same container. An `encode(to:)` that forgot to re-emit `kind` would
    /// still compile and would silently collapse every dashboard to
    /// `.noCommute` on reload: the user opens the app offline and is told they
    /// have no commute at all.
    @Test("commute dashboard keeps its case")
    func dashboard() throws {
        let original = try Fixtures.load("dashboard", as: DashboardResponse.self)
        guard case let .active(activeBefore) = original.state else {
            Issue.record("fixture should be an active dashboard")
            return
        }

        let data = try JSONEncoder.signaller.encode(original)
        let decoded = try JSONDecoder.signaller.decode(DashboardResponse.self, from: data)

        guard case let .active(activeAfter) = decoded.state else {
            Issue.record("round trip lost the .active case")
            return
        }
        #expect(activeAfter.commuteId == activeBefore.commuteId)
        #expect(activeAfter.commuteLabel == activeBefore.commuteLabel)
        #expect(activeAfter.leg.originCrs == activeBefore.leg.originCrs)
        #expect(activeAfter.journeys.count == activeBefore.journeys.count)
    }

    @Test("every dashboard case round-trips to itself")
    func allDashboardCases() throws {
        // `no-active` carries the reason nothing is scheduled, which is the
        // most useful thing on an otherwise empty screen.
        let noActive = #"""
        {"kind":"no-active","commuteId":"c1","commuteLabel":"Work",
        "reason":"holiday","otherCommutes":[]}
        """#
        let state = try JSONDecoder.signaller.decode(DashboardState.self, from: Data(noActive.utf8))
        let data = try JSONEncoder.signaller.encode(state)
        let back = try JSONDecoder.signaller.decode(DashboardState.self, from: data)
        guard case let .noActive(quiet) = back else {
            Issue.record("no-active did not survive")
            return
        }
        #expect(quiet.reason == "holiday")

        // And the empty case.
        let none = try JSONDecoder.signaller.decode(
            DashboardState.self, from: Data(#"{"kind":"no-commute"}"#.utf8)
        )
        let noneBack = try JSONDecoder.signaller.decode(
            DashboardState.self, from: try JSONEncoder.signaller.encode(none)
        )
        guard case .noCommute = noneBack else {
            Issue.record("no-commute did not survive")
            return
        }
    }

    /// Dates are the other thing a round trip can quietly ruin.
    @Test("timestamps keep their exact instant")
    func datesSurvive() throws {
        let board = try Fixtures.load("board", as: BoardResponse.self)
        let generatedAt = try #require(board.board?.generatedAt)

        let data = try JSONEncoder.signaller.encode(board)
        let decoded = try JSONDecoder.signaller.decode(BoardResponse.self, from: data)

        // Sub-second precision matters: the encoder writes fractional seconds
        // because that's what the backend emits and what the decoder tries
        // first. Dropping them would shift every cached timestamp.
        #expect(decoded.board?.generatedAt == generatedAt)
    }
}
