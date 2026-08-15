import Foundation
import MapKit
import Testing
@testable import Signaller

/// Map thinning and delta handling.
///
/// The thinning test exists because of a bug a screenshot caught: capping by
/// "nearest the centre" drew every marker in a blob over northern England and
/// left the rest of the country empty, which misrepresents where trains are.
@Suite("Map model")
@MainActor
struct MapModelTests {
    /// Trains on an even lat/lon lattice across Great Britain.
    private func spreadAcrossBritain(count: Int) -> [LiveTrain] {
        let side = Int(Double(count).squareRoot().rounded(.up))
        return (0..<count).map { index in
            let row = index / side, column = index % side
            return LiveTrain(
                id: "T\(index)",
                lat: 50.0 + (Double(row) / Double(side)) * 8.0,      // 50°N – 58°N
                lon: -5.0 + (Double(column) / Double(side)) * 7.0,   // 5°W – 2°E
                headcode: "1A\(index)",
                operatorName: nil, latenessMinutes: nil, reportedAgoSeconds: nil,
                rid: nil, atName: nil, atCrs: nil, event: nil,
                towardName: nil, destName: nil, nextLat: nil, nextLon: nil
            )
        }
    }

    private var britain: MKCoordinateRegion {
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 54, longitude: -2.5),
            span: MKCoordinateSpan(latitudeDelta: 11, longitudeDelta: 11)
        )
    }

    private func loadSnapshot(_ model: MapModel, trains: [LiveTrain]) throws {
        let json = try JSONEncoder().encode(EncodableSnapshot(
            generatedAt: "2026-08-15T06:00:00.000Z", count: trains.count, trains: trains
        ))
        model.applyForTesting(SSEEvent(name: "snapshot", data: String(decoding: json, as: UTF8.self)))
    }

    @Test("everything is drawn when under the cap")
    func underCap() throws {
        let model = MapModel()
        try loadSnapshot(model, trains: spreadAcrossBritain(count: 40))
        #expect(model.visibleTrains(in: britain).count == 40)
        #expect(model.hiddenCount(in: britain) == 0)
    }

    @Test("thinning spreads across the region rather than clustering centrally")
    func thinningIsSpatiallyEven() throws {
        let model = MapModel()
        try loadSnapshot(model, trains: spreadAcrossBritain(count: 1600))

        let shown = model.visibleTrains(in: britain)
        #expect(shown.count <= MapModel.visibleLimit)
        #expect(!shown.isEmpty)

        // The real test: markers must reach the edges of the region, not
        // huddle around its centre. Split into quadrants — every one should
        // have something in it.
        let centre = britain.center
        var quadrants = Set<String>()
        for train in shown {
            let vertical = train.lat >= centre.latitude ? "N" : "S"
            let horizontal = train.lon >= centre.longitude ? "E" : "W"
            quadrants.insert(vertical + horizontal)
        }
        #expect(quadrants.count == 4, "expected trains in all four quadrants, got \(quadrants.sorted())")

        // And the spread should cover most of the region's height, not a disc
        // in the middle.
        let latitudes = shown.map(\.lat)
        let spread = (latitudes.max() ?? 0) - (latitudes.min() ?? 0)
        #expect(spread > britain.span.latitudeDelta * 0.5)
    }

    @Test("the count in view is reported honestly")
    func honestCounts() throws {
        let model = MapModel()
        try loadSnapshot(model, trains: spreadAcrossBritain(count: 1600))
        // The status bar leads with the true total, not the drawn subset —
        // "250 shown" alone reads as though that's all there is.
        #expect(model.totalInView(in: britain) == 1600)
        #expect(model.hiddenCount(in: britain) > 0)
        #expect(model.totalInView(in: britain)
                == model.visibleTrains(in: britain).count + model.hiddenCount(in: britain))
    }

    @Test("trains outside the region aren't drawn")
    func outsideRegionExcluded() throws {
        let model = MapModel()
        try loadSnapshot(model, trains: spreadAcrossBritain(count: 40))
        let paris = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 48.86, longitude: 2.35),
            span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
        )
        #expect(model.visibleTrains(in: paris).isEmpty)
    }

    @Test("a snapshot replaces rather than merges, so reconnects leave no ghosts")
    func snapshotReplaces() throws {
        let model = MapModel()
        try loadSnapshot(model, trains: spreadAcrossBritain(count: 40))
        #expect(model.visibleTrains(in: britain).count == 40)

        // A snapshot arrives on every reconnect precisely so a missed delta
        // can't strand a train on the map forever.
        try loadSnapshot(model, trains: Array(spreadAcrossBritain(count: 40).prefix(3)))
        #expect(model.visibleTrains(in: britain).count == 3)
    }

    @Test("a delta upserts and removes")
    func deltaApplies() throws {
        let model = MapModel()
        let trains = spreadAcrossBritain(count: 10)
        try loadSnapshot(model, trains: trains)

        let json = try JSONEncoder().encode(EncodableDelta(
            generatedAt: "2026-08-15T06:00:05.000Z",
            count: 10,
            upserted: [trains[0]],
            removed: [trains[1].id, trains[2].id]
        ))
        model.applyForTesting(SSEEvent(name: "delta", data: String(decoding: json, as: UTF8.self)))
        #expect(model.visibleTrains(in: britain).count == 8)
    }
}

// Encodable mirrors, so tests can build payloads in the wire format.
private struct EncodableSnapshot: Encodable {
    let generatedAt: String
    let count: Int
    let trains: [LiveTrain]
}

private struct EncodableDelta: Encodable {
    let generatedAt: String
    let count: Int
    let upserted: [LiveTrain]
    let removed: [String]
}

extension LiveTrain: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(lat, forKey: .lat)
        try c.encode(lon, forKey: .lon)
        try c.encodeIfPresent(headcode, forKey: .headcode)
        try c.encodeIfPresent(latenessMinutes, forKey: .latenessMinutes)
        try c.encodeIfPresent(rid, forKey: .rid)
    }

    private enum CodingKeys: String, CodingKey {
        case id, lat, lon, headcode, latenessMinutes, rid
    }
}
