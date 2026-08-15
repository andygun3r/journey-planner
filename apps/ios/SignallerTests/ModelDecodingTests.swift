import Foundation
import Testing
@testable import Signaller

/// Decodes real captured API responses.
///
/// Fixtures are genuine output from a running backend, not hand-written JSON,
/// so these catch server shape drift at build time — the failure that produced
/// the `timetable` mismatch found during Phase 3.
@Suite("Model decoding")
struct ModelDecodingTests {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try Fixtures.load(name, as: type)
    }

    @Test("departure board")
    func board() throws {
        let response = try fixture("board", as: BoardResponse.self)
        let board = try #require(response.board)
        #expect(response.ok)
        #expect(board.stationName == "London Waterloo")
        #expect(!board.departures.isEmpty)

        // The timestamps in this fixture carry .000Z — the exact shape that
        // used to render as "2026-".
        let first = try #require(board.departures.first)
        #expect(first.effectiveTime.hhmm.count == 5)
        #expect(first.effectiveTime.hhmm.contains(":"))
    }

    @Test("station search keeps stations and places apart")
    func stations() throws {
        let response = try fixture("stations", as: StationSearchResponse.self)
        #expect(!response.stations.isEmpty)
        // Two separate arrays by design: a station must never lose its place
        // in the list to a similarly-named shop.
        #expect(response.stations.allSatisfy { $0.crs.count == 3 })
    }

    @Test("health decodes timetable as an object, not a boolean")
    func health() throws {
        // This was a real mismatch: the model declared `timetable: Bool?` and
        // the API returns an object with staleness detail.
        let response = try fixture("health", as: HealthResponse.self)
        #expect(response.ok)
        #expect(response.postgres)
        #expect(response.timetable?.summary != nil)
    }

    @Test("commute dashboard decodes as a discriminated union")
    func dashboard() throws {
        let response = try fixture("dashboard", as: DashboardResponse.self)
        guard case let .active(active) = response.state else {
            Issue.record("expected an active dashboard")
            return
        }
        #expect(!active.commuteLabel.isEmpty)
        #expect(!active.leg.originCrs.isEmpty)
        #expect(active.leg.directionLabel == (active.leg.direction == "am" ? "To work" : "Home"))
    }

    @Test("every no-active reason gets its own explanation")
    func dashboardReasons() throws {
        for reason in ["holiday", "no-leg-today", "skipped", "rest-of-day"] {
            let json = #"{"kind":"no-active","commuteId":"c","commuteLabel":"L","reason":"\#(reason)","otherCommutes":[]}"#
            let state = try JSONDecoder.signaller.decode(DashboardState.self, from: Data(json.utf8))
            guard case let .noActive(quiet) = state else {
                Issue.record("expected no-active for \(reason)")
                return
            }
            // The reason nothing is scheduled is the most useful thing on an
            // otherwise empty screen — it must never collapse to one message.
            #expect(!quiet.explanation.isEmpty)
            #expect(quiet.explanation != "Nothing scheduled right now.")
        }
    }

    @Test("alerts")
    func alerts() throws {
        let response = try fixture("alerts", as: AlertsResponse.self)
        let first = try #require(response.alerts.first)
        #expect(!first.headline.isEmpty)
        #expect(!first.kindLabel.isEmpty)
        // An unknown kind must not crash the list.
        let odd = try JSONDecoder.signaller.decode(
            AlertItem.self,
            from: Data(#"{"id":"1","kind":"brand_new","headline":"H","createdAt":"2026-08-15T06:00:00.000Z"}"#.utf8)
        )
        #expect(odd.kindLabel == "Brand New")
    }

    @Test("journeys: ok:false with HTTP 200 is a result, not an error")
    func noJourneys() throws {
        // The distinction the old client collapsed.
        let response = try JSONDecoder.signaller.decode(
            JourneyResponse.self,
            from: Data(#"{"ok":false,"reason":"no-journeys"}"#.utf8)
        )
        #expect(!response.ok)
        #expect(response.reason == "no-journeys")
        #expect(response.journeys == nil)
    }
}

@Suite("Live map data")
struct LiveTrainTests {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try Fixtures.load(name, as: type)
    }

    @Test("snapshot decodes")
    func snapshot() throws {
        let snapshot = try fixture("live-trains-snapshot", as: LiveTrainsSnapshot.self)
        #expect(snapshot.trains.count == snapshot.count)
        let train = try #require(snapshot.trains.first)
        #expect(!train.id.isEmpty)
        #expect(train.coordinate.latitude != 0)
    }

    @Test("delta decodes upserts and removals")
    func delta() throws {
        let delta = try fixture("live-trains-delta", as: LiveTrainsDelta.self)
        #expect(!delta.upserted.isEmpty)
        #expect(!delta.removed.isEmpty)
    }

    @Test("lateness reads in words, in both directions")
    func latenessLabels() throws {
        func train(_ lateness: Double?) throws -> LiveTrain {
            let value = lateness.map { "\($0)" } ?? "null"
            return try JSONDecoder.signaller.decode(
                LiveTrain.self,
                from: Data(#"{"id":"x","lat":51.5,"lon":-0.1,"latenessMinutes":\#(value)}"#.utf8)
            )
        }
        #expect(try train(12).latenessLabel == "12 min late")
        #expect(try train(-3).latenessLabel == "3 min early")
        #expect(try train(0).latenessLabel == "On time")
        // No report is not "on time" — absence of data isn't good news.
        #expect(try train(nil).latenessLabel == "No report")
        #expect(try train(12).tone == .bad)
        #expect(try train(0).tone == .good)
        #expect(try train(nil).tone == .neutral)
    }

    @Test("a long-unreported position is marked stale")
    func staleness() throws {
        func train(_ ago: Double) throws -> LiveTrain {
            try JSONDecoder.signaller.decode(
                LiveTrain.self,
                from: Data(#"{"id":"x","lat":51.5,"lon":-0.1,"reportedAgoSeconds":\#(ago)}"#.utf8)
            )
        }
        #expect(try !train(60).isStale)
        // Still shown, but labelled — a quiet feed is not a vanished train.
        #expect(try train(1200).isStale)
    }
}
