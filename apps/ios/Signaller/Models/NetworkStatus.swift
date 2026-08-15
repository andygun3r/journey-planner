import Foundation

/// Network-wide status: punctuality, operator performance, engineering works
/// and TfL line status.
///
/// The Status screen was a `/api/health` check — Postgres up, Redis up — which
/// is developer information. `/api/status` is what a passenger actually wants
/// to know, and nothing called it.
struct NetworkStatus: Codable {
    let updatedAt: Date
    let national: OperatorPerformance
    let operators: [OperatorPerformance]
    let tflLines: [TflLineStatus]
    let engineeringWorks: [EngineeringWork]
    /// Short-notice schedule changes entered today.
    let vstpToday: Int?
}

/// Punctuality for one operator, or the network as a whole.
struct OperatorPerformance: Codable, Identifiable, Hashable {
    let code: String
    let name: String
    let total: Int?
    let onTime: Int?
    let late: Int?
    let cancelVeryLate: Int?
    /// Public Performance Measure: the percentage arriving on time.
    let ppm: Int?
    /// The same figure over a longer window, so a single bad hour doesn't
    /// dominate.
    let rollingPpm: Int?
    let status: String?
    /// Live disruption detail. An object, not a string — caught by decoding a
    /// real capture rather than the first operator in the list, which was null.
    let disruption: OperatorDisruption?

    var id: String { code }

    /// The most useful sentence about this operator, if there is one.
    var disruptionHeadline: String? {
        disruption?.statusDescription ?? disruption?.disruptions?.first?.summary
    }

    /// Colour *and* wording — status is never carried by hue alone.
    var tone: PillTone {
        switch status {
        case "good": return .good
        case "minor": return .warn
        case "poor": return .bad
        default: return .neutral
        }
    }

    var statusLabel: String {
        switch status {
        case "good": return "Good"
        case "minor": return "Some delays"
        case "poor": return "Poor"
        default: return "No data"
        }
    }

    /// "79% on time", or nil when there's nothing measured yet.
    var ppmLabel: String? {
        guard let ppm else { return nil }
        return "\(ppm)% on time"
    }

    /// How many trains the figure is based on. A PPM computed from five trains
    /// is not the same claim as one from eight thousand, and saying the sample
    /// size is the difference between a statistic and a number.
    var sampleLabel: String? {
        guard let total, total > 0 else { return nil }
        return total == 1 ? "1 train" : "\(total) trains"
    }
}

/// What's currently wrong on an operator's network.
struct OperatorDisruption: Codable, Hashable {
    let status: String?
    let statusDescription: String?
    let disruptions: [DisruptionDetail]?
}

struct DisruptionDetail: Codable, Hashable, Identifiable {
    let id: String
    let summary: String?
    /// True for engineering work, false for something that has gone wrong.
    let planned: Bool?
}

struct TflLineStatus: Codable, Identifiable, Hashable {
    let lineId: String
    let lineName: String
    /// TfL's own scale: 10 is Good Service, lower is worse.
    let statusSeverity: Int
    let statusSeverityDescription: String
    let reason: String?

    var id: String { lineId }

    var isGood: Bool { statusSeverity >= 10 }

    var tone: PillTone {
        if statusSeverity >= 10 { return .good }
        if statusSeverity >= 6 { return .warn }
        return .bad
    }
}

struct EngineeringWork: Codable, Identifiable, Hashable {
    let incidentId: String?
    let summary: String?
    let description: String?
    let startDate: String?
    let endDate: String?

    /// Stable without a server id: falls back to the content, never a fresh
    /// UUID (which would break `ForEach` identity on every render — the
    /// `Coach.id` mistake).
    var id: String {
        incidentId ?? "\(startDate ?? "")-\(summary ?? description ?? "work")"
    }

    var dateRange: String? {
        guard let startDate else { return nil }
        guard let endDate, endDate != startDate else { return startDate.prettyDate }
        return "\(startDate.prettyDate) – \(endDate.prettyDate)"
    }

    private enum CodingKeys: String, CodingKey {
        case summary, description, startDate, endDate
        case incidentId = "id"
    }
}
