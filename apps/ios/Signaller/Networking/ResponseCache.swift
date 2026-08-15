import Foundation

/// Last-known-good API responses, on disk, with the time they were stored.
///
/// The app had no persistence of any kind, so a cold launch without signal was
/// a set of empty screens — for a product whose premise is "know before you
/// go", on a platform where signal is worst.
///
/// Deliberately a plain `Codable`-to-disk store rather than SwiftData: every
/// item here is a whole-response snapshot the server owns. There is no local
/// mutation to reconcile, no relationships, and no query beyond "the last
/// response for this key". A departure board 40 minutes old should be thrown
/// away, not migrated.
///
/// **The timestamp is the point.** `URLCache` would serve a stale board as
/// though it were fresh; this returns `storedAt` so the UI can say "last
/// updated 4 minutes ago" using the vocabulary the app already speaks
/// (`StatusFormatting.reportedAgo`). Never showing an age would be worse than
/// showing nothing.
///
/// An `actor`, so file I/O stays off the main actor and the type is
/// `Sendable`-correct under Swift 6.
actor ResponseCache {
    /// A stored value and when it was written.
    struct Entry<Value: Codable>: Codable {
        let value: Value
        let storedAt: Date
    }

    /// Cache keys. An enum rather than free strings so a typo can't silently
    /// create a second, never-read cache entry.
    enum Key: Hashable {
        case board(crs: String)
        case journeys(from: String, to: String)
        case dashboard
        case alerts
        case favourites
        case stations

        /// Safe as a filename — CRS codes and endpoint ids are alphanumeric,
        /// but a place id (`place:12345`) is not.
        var filename: String {
            let raw: String
            switch self {
            case let .board(crs): raw = "board-\(crs)"
            case let .journeys(from, to): raw = "journeys-\(from)-\(to)"
            case .dashboard: raw = "dashboard"
            case .alerts: raw = "alerts"
            case .favourites: raw = "favourites"
            case .stations: raw = "stations"
            }
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
            return raw.unicodeScalars
                .map { allowed.contains($0) ? Character($0) : "_" }
                .reduce(into: "") { $0.append($1) }
                + ".json"
        }
    }

    private let directory: URL
    private let fileManager = FileManager.default

    /// `Library/Caches`: the OS may evict it under pressure, which is exactly
    /// right for disposable data, and it's excluded from backup automatically.
    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            self.directory = caches.appendingPathComponent("ResponseCache", isDirectory: true)
        }
    }

    // MARK: - Reading and writing

    func store<Value: Codable>(_ value: Value, for key: Key) {
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            let entry = Entry(value: value, storedAt: Date())
            let data = try JSONEncoder.signaller.encode(entry)
            // Write to a temporary file and move it into place, so a crash or
            // an eviction mid-write can't leave a half-written file that looks
            // like a valid cache hit.
            let temporary = directory.appendingPathComponent(UUID().uuidString)
            try data.write(to: temporary, options: .atomic)
            let destination = directory.appendingPathComponent(key.filename)
            _ = try? fileManager.replaceItemAt(destination, withItemAt: temporary)
        } catch {
            // A cache that can't write is a degraded experience, never a
            // failure the user should see — the network path still works.
        }
    }

    /// The stored value and its age, or nil if there isn't one.
    func load<Value: Codable>(_ type: Value.Type, for key: Key) -> (value: Value, storedAt: Date)? {
        let url = directory.appendingPathComponent(key.filename)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let entry = try? JSONDecoder.signaller.decode(Entry<Value>.self, from: data) else {
            // A corrupt or outdated-shape entry is discarded rather than
            // thrown: a cache miss is recoverable, a crash on launch is not.
            try? fileManager.removeItem(at: url)
            return nil
        }
        return (entry.value, entry.storedAt)
    }

    func remove(_ key: Key) {
        try? fileManager.removeItem(at: directory.appendingPathComponent(key.filename))
    }

    /// Drops everything older than `age`. Called on launch.
    func purge(olderThan age: TimeInterval) {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }

        let cutoff = Date().addingTimeInterval(-age)
        for url in contents {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate
            if let modified, modified < cutoff {
                try? fileManager.removeItem(at: url)
            }
        }
    }

    /// Everything, e.g. on sign-out — cached favourites and dashboards belong
    /// to the account that fetched them.
    func removeAll() {
        try? fileManager.removeItem(at: directory)
    }
}

/// How old cached data may be before the UI must treat it as stale.
///
/// These are display thresholds, not eviction: a board older than its ceiling
/// is still shown (it's better than nothing on a platform with no signal), but
/// it has to be labelled as timetable-only rather than live.
enum CacheAge {
    /// A live departure board goes stale fast.
    static let board: TimeInterval = 10 * 60
    static let journeys: TimeInterval = 30 * 60
    static let dashboard: TimeInterval = 60 * 60
    /// The station list barely changes.
    static let stations: TimeInterval = 7 * 24 * 60 * 60
    /// Anything on disk longer than this is dropped at launch.
    static let purge: TimeInterval = 7 * 24 * 60 * 60
}
