import CoreLocation
import Foundation
import MapKit
import Observation

/// Holds the live train set for the map.
///
/// The national feed is ~1,700 trains. Annotating all of them stutters badly
/// and says nothing useful at national zoom, so the view only ever renders
/// what's in the visible region, capped — the same instinct as the web map's
/// bbox queries.
@Observable
@MainActor
final class MapModel {
    /// Whether we have actually heard from the feed.
    ///
    /// Without this the map could only say "N trains", so a failed poll — or a
    /// stream that never connected — rendered "0 trains", which is not "we
    /// don't know" but an affirmative claim that no trains are running in
    /// Great Britain. PRODUCT.md: honest uncertainty, never vague reassurance.
    enum Feed: Equatable {
        /// Nothing received yet.
        case idle
        /// A snapshot or delta arrived at this time.
        case loaded(at: Date)
        /// The last attempt failed and we have nothing to show.
        case failed(APIError)
    }

    /// Everything the feed knows about, keyed by id for cheap delta updates.
    ///
    /// The observer invalidates the thinning cache structurally, so a new
    /// mutation site can't forget to — which would leave the map drawing a
    /// stale set of markers.
    private(set) var trains: [String: LiveTrain] = [:] {
        didSet { version &+= 1 }
    }
    private(set) var live: LiveChannel?
    private(set) var feed: Feed = .idle

    /// When the data on screen was generated, or nil if none has arrived.
    var lastUpdated: Date? {
        if case let .loaded(at) = feed { return at }
        return nil
    }

    /// The most annotations worth drawing at once. Past this the map is a
    /// smear of pins rather than information.
    static let visibleLimit = 250

    /// Trains inside `region`, thinned out evenly across it.
    ///
    /// Thinning is grid-based, not nearest-to-centre. Sorting by distance from
    /// the centre and taking the first N draws a tight blob in the middle of
    /// the screen and leaves the rest of the country empty — which
    /// misrepresents where trains actually are. One train per grid cell keeps
    /// the national picture honest, and cells only get smaller as you zoom in,
    /// so detail arrives where you're looking.
    func visibleTrains(in region: MKCoordinateRegion) -> [LiveTrain] {
        thinned(in: region).drawn
    }

    /// What's drawn, and how many are in view altogether.
    ///
    /// Computed once and memoised. The view body calls `visibleTrains`,
    /// `totalInView` and `hiddenCount` on every render, and `hiddenCount`
    /// itself called the other two — so a single frame ran the region filter
    /// four times and the grid pass three times over ~1,700 trains.
    private func thinned(in region: MKCoordinateRegion) -> Thinned {
        let key = CacheKey(region: region, version: version)
        if let cached = thinnedCache, cached.key == key { return cached.value }

        let inside = trainsInside(region)
        let value: Thinned

        if inside.count <= Self.visibleLimit {
            value = Thinned(drawn: inside.sorted { $0.id < $1.id }, totalInView: inside.count)
        } else {
            // Grid fine enough that a full grid is roughly the display cap.
            let cells = max(1, Int(Double(Self.visibleLimit).squareRoot()))
            let latStep = region.span.latitudeDelta / Double(cells)
            let lonStep = region.span.longitudeDelta / Double(cells)

            var chosen: [GridKey: LiveTrain] = [:]
            for train in inside {
                let gridKey = GridKey(
                    x: Int32((train.lat / latStep).rounded(.down)),
                    y: Int32((train.lon / lonStep).rounded(.down))
                )
                // Within a cell, prefer the most disrupted train — if only one
                // marker can be drawn there, it should be the one worth seeing.
                if let existing = chosen[gridKey],
                   (existing.latenessMinutes ?? 0) >= (train.latenessMinutes ?? 0) {
                    continue
                }
                chosen[gridKey] = train
            }
            // Sorted before truncating: `Dictionary.values` has no defined
            // order, so the drawn subset used to change between renders even
            // when the data hadn't, and markers visibly flickered in and out.
            let drawn = chosen.values
                .sorted { $0.id < $1.id }
                .prefix(Self.visibleLimit)
                .map { $0 }
            value = Thinned(drawn: drawn, totalInView: inside.count)
        }

        thinnedCache = (key, value)
        return value
    }

    private struct Thinned {
        let drawn: [LiveTrain]
        let totalInView: Int
    }

    /// Invalidation: the visible region plus a counter bumped on every data
    /// change. Comparing the train dictionary itself would cost more than the
    /// work it saves.
    private struct CacheKey: Equatable {
        let latitude: Double
        let longitude: Double
        let latitudeDelta: Double
        let longitudeDelta: Double
        let version: Int

        init(region: MKCoordinateRegion, version: Int) {
            latitude = region.center.latitude
            longitude = region.center.longitude
            latitudeDelta = region.span.latitudeDelta
            longitudeDelta = region.span.longitudeDelta
            self.version = version
        }
    }

    private var thinnedCache: (key: CacheKey, value: Thinned)?
    /// Bumped whenever `trains` changes.
    private var version = 0

    /// A grid cell. Replaces interpolating a `String` key per train per
    /// render — the hottest line in the app at national zoom.
    private struct GridKey: Hashable {
        let x: Int32
        let y: Int32
    }

    private func trainsInside(_ region: MKCoordinateRegion) -> [LiveTrain] {
        let latHalf = region.span.latitudeDelta / 2
        let lonHalf = region.span.longitudeDelta / 2
        let centre = region.center
        return trains.values.filter { train in
            abs(train.lat - centre.latitude) <= latHalf
                && abs(train.lon - centre.longitude) <= lonHalf
        }
    }

    /// How many trains are in view but not drawn, because the grid thinned
    /// them out. The UI says so rather than silently showing a subset of a
    /// national feed.
    func hiddenCount(in region: MKCoordinateRegion) -> Int {
        let result = thinned(in: region)
        return max(0, result.totalInView - result.drawn.count)
    }

    /// Every train in view, drawn or not — the honest total for the status bar.
    func totalInView(in region: MKCoordinateRegion) -> Int {
        thinned(in: region).totalInView
    }

    // MARK: - Live feed

    func start(api: APIClient, auth: AuthStore) {
        guard live == nil else { return }
        let channel = LiveChannel(path: "/api/live/trains", api: api, auth: auth) { [weak self] event in
            self?.apply(event)
        }
        live = channel
        channel.start()
    }

    func stop() {
        live?.stop()
        live = nil
    }

    private func apply(_ event: SSEEvent) {
        guard let data = event.data.data(using: .utf8) else { return }
        switch event.name {
        case "snapshot":
            // A snapshot is the whole truth — replace, don't merge. It arrives
            // on every reconnect precisely so a missed delta can't leave a
            // ghost train on the map.
            guard let snapshot = try? JSONDecoder.signaller.decode(LiveTrainsSnapshot.self, from: data) else { return }
            trains = Dictionary(uniqueKeysWithValues: snapshot.trains.map { ($0.id, $0) })
            feed = .loaded(at: snapshot.generatedAt)

        case "delta":
            guard let delta = try? JSONDecoder.signaller.decode(LiveTrainsDelta.self, from: data) else { return }
            for train in delta.upserted { trains[train.id] = train }
            for id in delta.removed { trains.removeValue(forKey: id) }
            feed = .loaded(at: delta.generatedAt)

        default:
            break
        }
    }

    /// Feeds one stream event straight in, so tests exercise the real
    /// snapshot/delta path rather than a reimplementation of it.
    func applyForTesting(_ event: SSEEvent) {
        apply(event)
    }

    /// One-shot poll, for when the server has no Redis and the stream reported
    /// `unavailable`.
    ///
    /// A failure here used to be swallowed with `try?`, leaving an empty train
    /// set that the status bar reported as "0 trains" — the whole reason
    /// `Feed` exists.
    func poll(using api: APIClient) async {
        do {
            let snapshot = try await api.liveTrains()
            trains = Dictionary(uniqueKeysWithValues: snapshot.trains.map { ($0.id, $0) })
            feed = .loaded(at: snapshot.generatedAt)
        } catch let error as APIError {
            recordFailure(error)
        } catch {
            recordFailure(.transport(error.localizedDescription))
        }
    }

    /// Keeps whatever is already drawn — a failed refresh doesn't mean the
    /// trains vanished — but stops claiming the count is current.
    private func recordFailure(_ error: APIError) {
        if trains.isEmpty { feed = .failed(error) }
    }

    var shouldPoll: Bool { live?.state.needsPolling ?? true }
}
