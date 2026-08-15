import Foundation

struct AlertsResponse: Codable {
    let alerts: [AlertItem]
}

/// One commute alert. Mirrors the `alert` table.
struct AlertItem: Codable, Identifiable, Hashable {
    let id: String
    let commuteId: String?
    /// cancellation | delay | kb_incident | pin_stale | pre_departure | network_disruption
    let kind: String
    let headline: String
    let detail: String?
    /// "am" | "pm" | nil
    let direction: String?
    let createdAt: Date
    /// nil until the user has seen it.
    let seenAt: Date?

    var isUnseen: Bool { seenAt == nil }

    var symbolName: String {
        switch kind {
        case "cancellation": return "xmark.octagon.fill"
        case "delay": return "clock.badge.exclamationmark.fill"
        case "pin_stale": return "pin.slash.fill"
        case "pre_departure": return "bell.fill"
        case "network_disruption", "kb_incident": return "exclamationmark.triangle.fill"
        default: return "info.circle.fill"
        }
    }

    var tone: PillTone {
        switch kind {
        case "cancellation": return .bad
        case "delay", "network_disruption", "kb_incident", "pin_stale": return .warn
        default: return .neutral
        }
    }

    /// "Cancellation", "Delay", … for the row's label.
    var kindLabel: String {
        switch kind {
        case "cancellation": return "Cancellation"
        case "delay": return "Delay"
        case "pin_stale": return "Pinned train changed"
        case "pre_departure": return "Leaving soon"
        case "network_disruption": return "Network"
        case "kb_incident": return "Engineering work"
        default: return kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

struct FavouritesResponse: Codable {
    let favourites: [Favourite]
}

/// A saved from→to pair.
struct Favourite: Codable, Identifiable, Hashable {
    var id: String { "\(from)-\(to)" }
    let from: String
    let to: String
    let fromName: String?
    let toName: String?
    let lastUsedAt: Date?

    var fromDisplay: String { fromName ?? from }
    var toDisplay: String { toName ?? to }
}
