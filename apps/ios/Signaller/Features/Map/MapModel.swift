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
    /// Everything the feed knows about, keyed by id for cheap delta updates.
    private(set) var trains: [String: LiveTrain] = [:]
    private(set) var live: LiveChannel?
    private(set) var lastUpdated: Date?

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
        let inside = trainsInside(region)
        guard inside.count > Self.visibleLimit else { return inside }

        // Grid fine enough that a full grid is roughly the display cap.
        let cells = max(1, Int(Double(Self.visibleLimit).squareRoot()))
        let latStep = region.span.latitudeDelta / Double(cells)
        let lonStep = region.span.longitudeDelta / Double(cells)

        var chosen: [String: LiveTrain] = [:]
        for train in inside {
            let key = "\(Int(train.lat / latStep)):\(Int(train.lon / lonStep))"
            // Within a cell, prefer the most disrupted train — if only one
            // marker can be drawn there, it should be the one worth seeing.
            if let existing = chosen[key],
               (existing.latenessMinutes ?? 0) >= (train.latenessMinutes ?? 0) {
                continue
            }
            chosen[key] = train
        }
        return Array(chosen.values.prefix(Self.visibleLimit))
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
        max(0, trainsInside(region).count - visibleTrains(in: region).count)
    }

    /// Every train in view, drawn or not — the honest total for the status bar.
    func totalInView(in region: MKCoordinateRegion) -> Int {
        trainsInside(region).count
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
            lastUpdated = snapshot.generatedAt

        case "delta":
            guard let delta = try? JSONDecoder.signaller.decode(LiveTrainsDelta.self, from: data) else { return }
            for train in delta.upserted { trains[train.id] = train }
            for id in delta.removed { trains.removeValue(forKey: id) }
            lastUpdated = delta.generatedAt

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
    func poll(using api: APIClient) async {
        guard let snapshot = try? await api.liveTrains() else { return }
        trains = Dictionary(uniqueKeysWithValues: snapshot.trains.map { ($0.id, $0) })
        lastUpdated = snapshot.generatedAt
    }

    var shouldPoll: Bool { live?.state.needsPolling ?? true }
}
