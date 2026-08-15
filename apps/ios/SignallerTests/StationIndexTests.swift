import Foundation
import Testing
@testable import Signaller

/// The on-device station ranking must agree with the server's.
///
/// This is the point of the port: typing "wat" has to give the same answer in
/// the same order whether or not there's signal. If the two diverged, the app
/// would quietly return different results depending on the user's connection,
/// which is harder to notice and worse than simply being offline.
///
/// The expected orderings below are golden values captured from a running
/// `/api/stations?q=` — not hand-written — so they encode the real behaviour
/// of `rank()` in apps/web/app/api/stations/route.ts.
@Suite("Station index")
@MainActor
struct StationIndexTests {
    /// The real bundled list, as shipped.
    private func stations() throws -> [Station] {
        let bundle = Bundle(for: BundleToken.self)
        // The app's copy is in the app bundle, not the test bundle, so fall
        // back to the fixture list when running against the test bundle only.
        if let url = Bundle.main.url(forResource: "stations", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder.signaller.decode([Station].self, from: data),
           decoded.count > 100 {
            return decoded
        }
        _ = bundle
        return try Fixtures.load("stations", as: StationSearchResponse.self).stations
    }

    private final class BundleToken {}

    @Test("ranking matches the server, in order", arguments: [
        ("wat", ["WAT", "WCT", "WTO", "WBC", "WFD", "WTR", "WLO", "WFH", "WFJ", "ZWT"]),
        ("brig", ["BGG", "BGH", "BTN", "NBN", "ALB", "BBG", "LRB", "SNA"]),
        ("clj", ["CLJ"]),
    ])
    func matchesServerOrdering(query: String, expected: [String]) throws {
        let all = try stations()
        // Only meaningful against the full list.
        try #require(all.count > 1000, "needs the bundled station list")

        let ranked = StationIndex.rank(all, query: query).map(\.crs)
        #expect(
            Array(ranked.prefix(expected.count)) == expected,
            "query \"\(query)\": got \(ranked.prefix(expected.count)), want \(expected)"
        )
    }

    @Test("an exact CRS wins outright")
    func exactCrsFirst() throws {
        let all = try stations()
        try #require(all.count > 1000)
        // "wat" is Waterloo's code and also a substring of many names.
        #expect(StationIndex.rank(all, query: "wat").first?.crs == "WAT")
        #expect(StationIndex.rank(all, query: "clj").first?.crs == "CLJ")
        // Case shouldn't matter.
        #expect(StationIndex.rank(all, query: "WAT").first?.crs == "WAT")
    }

    @Test("results are capped at twenty, like the route")
    func cappedAtTwenty() throws {
        let all = try stations()
        try #require(all.count > 1000)
        // "s" matches a very large number of stations.
        #expect(StationIndex.rank(all, query: "s").count <= 20)
    }

    @Test("an empty or whitespace query returns nothing")
    func emptyQuery() throws {
        let all = try stations()
        #expect(StationIndex.rank(all, query: "").isEmpty)
        #expect(StationIndex.rank(all, query: "   ").isEmpty)
    }

    @Test("no match is an empty list, not a crash")
    func noMatch() throws {
        let all = try stations()
        try #require(all.count > 1000)
        #expect(StationIndex.rank(all, query: "xyzzy").isEmpty)
    }

    @Test("a name prefix beats a mid-word match")
    func prefixBeatsContains() {
        let sample = [
            Station(crs: "AAA", name: "Something Brighton"),
            Station(crs: "BBB", name: "Brighton"),
        ]
        // "Brighton" starts with the query; "Something Brighton" only contains
        // it, so the prefix match must come first.
        #expect(StationIndex.rank(sample, query: "brig").map(\.crs) == ["BBB", "AAA"])
    }

    @Test("the bundled list ships with the app")
    func bundledListExists() throws {
        // Guards the build-phase wiring: an unbundled resource would make the
        // whole offline story silently fall back to nothing.
        let index = StationIndex()
        index.loadBundled()
        #expect(index.stations.count > 2000, "expected the full station list in the app bundle")
        #expect(index.source == .bundled)
        // And it must be usable immediately, with no network.
        #expect(!index.search("waterloo").isEmpty)
    }
}
