import CoreLocation
import Foundation

/// A train on the live map, from `/api/live/trains`.
struct LiveTrain: Decodable, Identifiable, Hashable {
    let id: String
    let lat: Double
    let lon: Double
    let headcode: String?
    let operatorName: String?
    let latenessMinutes: Double?
    let reportedAgoSeconds: Double?
    /// Darwin run id, once correlated — what the service detail screen needs.
    let rid: String?
    /// Where it last reported.
    let atName: String?
    let atCrs: String?
    /// "DEPARTURE" | "ARRIVAL" | berth pass.
    let event: String?
    /// The stop it's heading for, and that stop's position.
    let towardName: String?
    let destName: String?
    let nextLat: Double?
    let nextLon: Double?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    /// Tone for the marker. Colour is never the only cue — the callout spells
    /// the lateness out in words.
    var tone: PillTone {
        guard let lateness = latenessMinutes else { return .neutral }
        if lateness >= 10 { return .bad }
        if lateness >= 3 { return .warn }
        return .good
    }

    var latenessLabel: String {
        guard let lateness = latenessMinutes else { return "No report" }
        let rounded = Int(lateness.rounded())
        if rounded > 0 { return "\(rounded) min late" }
        if rounded < 0 { return "\(abs(rounded)) min early" }
        return "On time"
    }

    /// "2D68 to Lowestoft" — what the train is, in the way a passenger reads it.
    var title: String {
        let code = headcode ?? "Train"
        guard let destName else { return code }
        return "\(code) to \(destName)"
    }

    /// True when the last report is old enough that this position may be stale.
    /// Shown, but labelled — a quiet feed is not a vanished train.
    var isStale: Bool { (reportedAgoSeconds ?? 0) > 600 }
}

/// The `snapshot` event: the full set, sent on connect and every reconnect.
struct LiveTrainsSnapshot: Decodable {
    let generatedAt: Date
    let count: Int
    let trains: [LiveTrain]
}

/// The `delta` event: what changed since the last message.
struct LiveTrainsDelta: Decodable {
    let generatedAt: Date
    let count: Int
    let upserted: [LiveTrain]
    /// Ids that have dropped off the feed.
    let removed: [String]
}
