import Foundation
import Testing
@testable import Signaller

/// The offline store.
///
/// Each test uses its own temporary directory, so they can run concurrently
/// and never touch the real cache.
@Suite("Response cache")
struct ResponseCacheTests {
    private func makeCache() -> (ResponseCache, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("cache-test-\(UUID().uuidString)", isDirectory: true)
        return (ResponseCache(directory: directory), directory)
    }

    @Test("a stored value comes back with its age")
    func roundTrip() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        let board = try Fixtures.load("board", as: BoardResponse.self)
        await cache.store(board, for: .board(crs: "WAT"))

        let loaded = await cache.load(BoardResponse.self, for: .board(crs: "WAT"))
        let entry = try #require(loaded)
        #expect(entry.value.board?.stationName == board.board?.stationName)
        // The timestamp is the whole reason this exists rather than URLCache.
        #expect(abs(entry.storedAt.timeIntervalSinceNow) < 5)
    }

    @Test("a miss is nil, not an error")
    func miss() async {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        let loaded = await cache.load(BoardResponse.self, for: .board(crs: "ZZZ"))
        #expect(loaded == nil)
    }

    @Test("a corrupt entry is discarded rather than thrown")
    func corruptEntry() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = ResponseCache.Key.board(crs: "WAT")
        try Data("{ not json at all".utf8)
            .write(to: directory.appendingPathComponent(key.filename))

        // A cache miss is recoverable; a crash on launch is not.
        let loaded = await cache.load(BoardResponse.self, for: key)
        #expect(loaded == nil)
    }

    @Test("an entry of the wrong shape is discarded")
    func shapeDrift() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        // Simulates a model change since the entry was written — the app must
        // not fail to launch because last week's cache no longer decodes.
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = ResponseCache.Key.dashboard
        try Data(#"{"value":{"unexpected":true},"storedAt":"2026-08-15T07:00:00.000Z"}"#.utf8)
            .write(to: directory.appendingPathComponent(key.filename))

        let loaded = await cache.load(DashboardResponse.self, for: key)
        #expect(loaded == nil)
    }

    @Test("storing twice keeps the newer value")
    func overwrite() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        await cache.store(["first"], for: .alerts)
        await cache.store(["second"], for: .alerts)

        let loaded = await cache.load([String].self, for: .alerts)
        #expect(loaded?.value == ["second"])
    }

    @Test("removal works")
    func remove() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        await cache.store(["x"], for: .favourites)
        #expect(await cache.load([String].self, for: .favourites) != nil)
        await cache.remove(.favourites)
        #expect(await cache.load([String].self, for: .favourites) == nil)
    }

    @Test("purge drops old entries and keeps fresh ones")
    func purge() async throws {
        let (cache, directory) = makeCache()
        defer { try? FileManager.default.removeItem(at: directory) }

        await cache.store(["fresh"], for: .alerts)

        // Backdate one entry past the cutoff.
        let stale = ResponseCache.Key.favourites
        await cache.store(["stale"], for: stale)
        let staleURL = directory.appendingPathComponent(stale.filename)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-8 * 24 * 60 * 60)],
            ofItemAtPath: staleURL.path
        )

        await cache.purge(olderThan: 7 * 24 * 60 * 60)

        #expect(await cache.load([String].self, for: .alerts) != nil)
        #expect(await cache.load([String].self, for: stale) == nil)
    }

    @Test("keys with awkward characters produce safe filenames")
    func filenameSafety() {
        // A journeys key can carry `place:12345`, which is not a legal
        // filename component.
        let key = ResponseCache.Key.journeys(from: "place:12345", to: "WAT")
        let name = key.filename
        #expect(!name.contains(":"))
        #expect(!name.contains("/"))
        #expect(name.hasSuffix(".json"))
    }

    @Test("different keys don't collide")
    func keysAreDistinct() {
        let names = Set([
            ResponseCache.Key.board(crs: "WAT").filename,
            ResponseCache.Key.board(crs: "CLJ").filename,
            ResponseCache.Key.journeys(from: "WAT", to: "BTN").filename,
            ResponseCache.Key.journeys(from: "BTN", to: "WAT").filename,
            ResponseCache.Key.dashboard.filename,
            ResponseCache.Key.alerts.filename,
            ResponseCache.Key.favourites.filename,
            ResponseCache.Key.stations.filename,
        ])
        #expect(names.count == 8)
    }
}

@Suite("Staleness wording")
struct StalenessCopyTests {
    @Test("cached data always states its age")
    func lastUpdatedWording() {
        #expect(StatusFormatting.lastUpdated(secondsAgo: 10) == "Last updated just now")
        #expect(StatusFormatting.lastUpdated(secondsAgo: 60) == "Last updated 1 min ago")
        #expect(StatusFormatting.lastUpdated(secondsAgo: 240) == "Last updated 4 min ago")
        #expect(StatusFormatting.lastUpdated(secondsAgo: 3600) == "Last updated 1 hour ago")
        #expect(StatusFormatting.lastUpdated(secondsAgo: 7200) == "Last updated 2 hours ago")
        #expect(StatusFormatting.lastUpdated(secondsAgo: 86400) == "Last updated yesterday")
    }

    @Test("a stale board warns that times may have moved")
    func staleBoardWording() {
        let notice = StatusFormatting.staleBoardNotice(secondsAgo: 1800)
        #expect(notice.contains("30 min ago"))
        // It must not imply the times are still live.
        #expect(notice.contains("may have changed"))
    }
}
