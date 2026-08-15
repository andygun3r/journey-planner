import Foundation
import MapKit
import Testing
@testable import Signaller

/// Regression tests for the Phase 0 correctness fixes.
///
/// Each of these describes a defect a user could hit: a spinner that never
/// resolved, a board that stopped refreshing, a map that claimed there were no
/// trains. They exist so those states can't come back silently.
@Suite("Service detail", .serialized)
@MainActor
struct ServiceModelTests {
    /// A board row with neither a rid nor a trip id.
    ///
    /// Built by stripping both identifiers from a real captured departure, so
    /// the rest of the required shape stays honest to the API.
    private func untrackableDeparture() throws -> Departure {
        var object = try #require(
            try JSONSerialization.jsonObject(with: Fixtures.data("board")) as? [String: Any]
        )
        let board = try #require(object["board"] as? [String: Any])
        var departure = try #require((board["departures"] as? [[String: Any]])?.first)
        departure["rid"] = nil
        departure["tripId"] = nil
        object = departure
        return try JSONDecoder.signaller.decode(
            Departure.self,
            from: try JSONSerialization.data(withJSONObject: object)
        )
    }

    @Test("a departure with no id resolves to untrackable, never a stuck spinner")
    func untrackableIsNotLoading() throws {
        let departure = try untrackableDeparture()
        // This is not a hypothetical row: a live Waterloo board at 08:00 today
        // returned two departures, both with rid: nil.
        #expect(departure.rid == nil)
        #expect(departure.tripId == nil)

        let model = ServiceModel()
        // Mirrors what the view does when neither identifier is present.
        model.markUntrackable()

        if case .loading = model.phase {
            Issue.record("phase stayed .loading — this is the permanent spinner")
        }
        guard case .untrackable = model.phase else {
            Issue.record("expected .untrackable, got \(model.phase)")
            return
        }
    }

    @Test("a real service id loads")
    func loadsWithId() async throws {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        try stub.onFixture("/api/services/", "service")

        let model = ServiceModel()
        await model.load(serviceId: "rid:202608150731", using: api)
        guard case .loaded = model.phase else {
            Issue.record("expected .loaded, got \(model.phase)")
            return
        }
    }

    @Test("a 503 is a failure, not an untrackable train")
    func serverErrorIsFailure() async throws {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on("/api/services/", .json(#"{"ok":false}"#, status: 503))

        let model = ServiceModel()
        await model.load(serviceId: "rid:x", using: api)
        guard case .failed = model.phase else {
            Issue.record("expected .failed, got \(model.phase)")
            return
        }
    }
}

@Suite("Board", .serialized)
@MainActor
struct BoardModelTests {
    @Test("only a station can be loaded")
    func canLoadGatesOnStation() {
        let model = BoardModel()
        #expect(!model.canLoad)

        model.station = .place(id: "123", label: "10 Downing Street")
        // The button used to enable here and then do nothing at all.
        #expect(!model.canLoad)

        model.station = .station(crs: "WAT", name: "London Waterloo")
        #expect(model.canLoad)
    }

    @Test("loading a place produces an explicit outcome, not silence")
    func placeProducesOutcome() async {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()

        let model = BoardModel()
        model.station = .place(id: "123", label: "10 Downing Street")
        await model.load(using: api)

        guard case let .empty(reason) = model.phase else {
            Issue.record("expected .empty, got \(model.phase)")
            return
        }
        #expect(reason == "not-a-station")
        // And it must not have hit the network.
        #expect(stub.requestedPaths.isEmpty)
    }

    @Test("an empty board says so rather than showing nothing")
    func emptyBoard() async throws {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on(
            "/api/boards/",
            .json(#"""
            {"ok":true,"board":{"crs":"WAT","stationName":"London Waterloo",
            "generatedAt":"2026-08-15T07:00:00.000Z","live":true,"source":"ldbws",
            "messages":[],"disruptions":[],"departures":[],"arrivals":[]}}
            """#)
        )

        let model = BoardModel()
        model.station = .station(crs: "WAT", name: "London Waterloo")
        await model.load(using: api)

        guard case let .empty(reason) = model.phase else {
            Issue.record("expected .empty, got \(model.phase)")
            return
        }
        #expect(reason == "no-departures")
    }
}

@Suite("Favourites", .serialized)
@MainActor
struct FavouritesModelTests {
    @Test("a failed toggle rolls back and explains itself")
    func failedToggleRollsBack() async {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on("/api/favourites", .failure(.notConnectedToInternet))

        let model = FavouritesModel()
        #expect(!model.contains(from: "WAT", to: "BTN"))

        await model.toggle(from: "WAT", to: "BTN", using: api)

        // The optimistic insert must be undone…
        #expect(!model.contains(from: "WAT", to: "BTN"))
        // …and the user must be told why, rather than watching the star
        // silently snap back.
        #expect(model.toggleError != nil)
    }

    @Test("signed out means no favourites, not an error")
    func unauthorizedIsNotAnError() async {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on("/api/favourites", .json(#"{"ok":false}"#, status: 401))

        let model = FavouritesModel()
        await model.load(using: api)

        #expect(model.favourites.isEmpty)
        #expect(model.loaded)
    }

    @Test("contains is case-insensitive on both ends")
    func containsNormalises() async {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on(
            "/api/favourites",
            .json(#"""
            {"favourites":[{"from":"WAT","to":"BTN","fromName":"London Waterloo",
            "toName":"Brighton","lastUsedAt":null}]}
            """#)
        )

        let model = FavouritesModel()
        await model.load(using: api)
        #expect(model.contains(from: "wat", to: "btn"))
        #expect(model.contains(from: "WAT", to: "BTN"))
        #expect(!model.contains(from: "WAT", to: "CLJ"))
    }
}

@Suite("Map feed state", .serialized)
@MainActor
struct MapFeedTests {
    private var britain: MKCoordinateRegion {
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 54, longitude: -2.5),
            span: MKCoordinateSpan(latitudeDelta: 11, longitudeDelta: 11)
        )
    }

    @Test("a failed poll is recorded, never reported as zero trains")
    func failedPollIsNotZeroTrains() async {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on("/api/live-trains", .failure(.notConnectedToInternet))

        let model = MapModel()
        await model.poll(using: api)

        // The count is genuinely zero, but the *state* must say we never
        // heard — otherwise the UI claims no trains are running nationally.
        #expect(model.totalInView(in: britain) == 0)
        guard case .failed = model.feed else {
            Issue.record("expected .failed, got \(model.feed)")
            return
        }
        #expect(model.lastUpdated == nil)
    }

    @Test("a successful poll records when the data was generated")
    func successfulPollRecordsTime() async throws {
        let stub = StubURLProtocol.Stub()
        let api = stub.client()
        stub.on(
            "/api/live-trains",
            .json(#"{"generatedAt":"2026-08-15T07:00:00.000Z","count":1,"trains":[{"id":"a","lat":51.5,"lon":-0.1}]}"#)
        )

        let model = MapModel()
        await model.poll(using: api)

        guard case .loaded = model.feed else {
            Issue.record("expected .loaded, got \(model.feed)")
            return
        }
        #expect(model.lastUpdated != nil)
    }

    @Test("thinning is deterministic across repeated calls")
    func thinningIsStable() throws {
        let model = MapModel()
        // More trains than the display cap, spread across the country.
        let trains = (0..<1200).map { index -> LiveTrain in
            let row = index / 35, column = index % 35
            return LiveTrain(
                id: "T\(index)",
                lat: 50.0 + (Double(row) / 35.0) * 8.0,
                lon: -5.0 + (Double(column) / 35.0) * 7.0,
                headcode: nil, operatorName: nil, latenessMinutes: nil,
                reportedAgoSeconds: nil, rid: nil, atName: nil, atCrs: nil,
                event: nil, towardName: nil, destName: nil, nextLat: nil, nextLon: nil
            )
        }
        let json = try JSONEncoder().encode(
            EncodableSnapshotFixture(generatedAt: "2026-08-15T07:00:00.000Z", count: trains.count, trains: trains)
        )
        model.applyForTesting(SSEEvent(name: "snapshot", data: String(decoding: json, as: UTF8.self)))

        // `Dictionary.values` has no defined order. The *set* happened to be
        // stable — the grid holds at most 225 cells against a 250 cap, so the
        // `prefix` never actually truncated — but the ORDER was not, and
        // SwiftUI's `ForEach` diffs on position as well as identity, so
        // reordering alone rebuilds annotations and flickers markers.
        //
        // Asserting on the array (not a Set) is what makes this test real:
        // with the sort removed it fails, with it present it passes.
        let runs = (0..<8).map { _ in model.visibleTrains(in: britain).map(\.id) }
        for run in runs.dropFirst() {
            #expect(run == runs[0], "visibleTrains order is not deterministic")
        }
        #expect(!runs[0].isEmpty)
        // And the order should be meaningful, not incidental.
        #expect(runs[0] == runs[0].sorted())
    }
}

private struct EncodableSnapshotFixture: Encodable {
    let generatedAt: String
    let count: Int
    let trains: [LiveTrain]
}
