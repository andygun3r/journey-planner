import Foundation

/// The words and tones the user actually reads for a status.
///
/// Deliberately free functions over plain values: they're the most
/// user-visible logic in the app and the easiest thing to get subtly wrong, so
/// they're kept pure and unit-tested rather than buried in a view body.
enum StatusFormatting {
    /// Journey status for a results row.
    static func journeyLabel(status: JourneyStatus, delayMinutes: Int?) -> String {
        if status == .cancelled { return "Cancelled" }
        if let delay = delayMinutes, delay > 0 { return "\(delay) min late" }
        // A negative delay means running early — say so rather than "on time".
        if let delay = delayMinutes, delay < 0 { return "\(abs(delay)) min early" }
        switch status {
        case .onTime: return "On time"
        case .delayed: return "Delayed"
        case .cancelled: return "Cancelled"
        case .scheduled, .unknown: return "Scheduled"
        }
    }

    static func journeyTone(status: JourneyStatus) -> PillTone {
        switch status {
        case .cancelled: return .bad
        case .delayed: return .warn
        case .onTime: return .good
        case .scheduled, .unknown: return .neutral
        }
    }

    /// Departure-board status. Differs from the journey version in one way: a
    /// row with no live data reads "Scheduled", not "On time" — the board must
    /// not imply confirmation it hasn't received.
    static func departureLabel(status: JourneyStatus, delayMinutes: Int?, hasLive: Bool) -> String {
        if status == .cancelled { return "Cancelled" }
        if let delay = delayMinutes, delay > 0 { return "\(delay) min late" }
        if let delay = delayMinutes, delay < 0 { return "\(abs(delay)) min early" }
        if status == .onTime { return "On time" }
        if status == .delayed { return "Delayed" }
        return hasLive ? "Expected" : "Scheduled"
    }

    static func departureTone(status: JourneyStatus, hasLive: Bool) -> PillTone {
        switch status {
        case .cancelled: return .bad
        case .delayed: return .warn
        case .onTime: return .good
        case .scheduled, .unknown: return hasLive ? .good : .neutral
        }
    }

    /// Heading for a plan that returned no usable result.
    static func planFailureTitle(reason: String?) -> String {
        switch reason {
        case "engine-offline": return "Routing is offline"
        case "no-journeys": return "No journeys found"
        case "bad-request": return "Check those places"
        default: return "Couldn't plan that journey"
        }
    }

    static func planFailureMessage(reason: String?) -> String {
        switch reason {
        case "engine-offline":
            return "The routing engine isn't answering. This is usually brief — try again in a moment."
        case "no-journeys":
            return "Nothing runs between those places at that time. Try a different time or date."
        case "bad-request":
            return "Enter a station, postcode or address for both ends of the journey."
        default:
            return "Something went wrong planning that journey."
        }
    }

    static func boardFailureTitle(reason: String?) -> String {
        switch reason {
        case "unknown-station": return "Unknown station"
        case "engine-offline": return "Board source offline"
        case "not-a-station": return "Pick a station"
        default: return "Couldn't load that board"
        }
    }

    static func boardFailureMessage(reason: String?) -> String {
        switch reason {
        case "unknown-station":
            return "No station matched that code. Try searching by name."
        case "engine-offline":
            return "The live board source isn't answering. Try again in a moment."
        case "not-a-station":
            // Only reachable if a place gets selected some other way; the
            // picker no longer offers them here.
            return "Departure boards are per station — search for one by name."
        default:
            return "Something went wrong loading that board."
        }
    }

    /// "in 4 min", "now", or nil when it's already gone.
    ///
    /// Returns nil rather than a negative countdown: a departure in the past is
    /// not information, it's noise.
    static func countdown(to date: Date, now: Date = Date()) -> String? {
        let seconds = date.timeIntervalSince(now)
        if seconds < 0 { return nil }
        // Round *down*, not to nearest. Rounding to nearest turns 30 seconds
        // into "in 1 min", which tells someone they have a minute longer than
        // they do — on a departure board that's the wrong direction to be wrong.
        let minutes = Int(seconds / 60)
        if minutes == 0 { return "now" }
        if minutes == 1 { return "in 1 min" }
        if minutes < 60 { return "in \(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "in \(hours)h" : "in \(hours)h \(rest)m"
    }

    /// "Last updated 4 min ago" — how old cached data on screen is.
    ///
    /// Shown whenever the app is displaying a stored response because the
    /// network didn't answer. Saying the age out loud is the whole reason the
    /// cache stores a timestamp: silently serving a 40-minute-old board as
    /// though it were live is exactly what this product must not do.
    static func lastUpdated(secondsAgo seconds: Double) -> String {
        let minutes = Int(seconds / 60)
        if minutes <= 0 { return "Last updated just now" }
        if minutes == 1 { return "Last updated 1 min ago" }
        if minutes < 60 { return "Last updated \(minutes) min ago" }
        let hours = minutes / 60
        if hours == 1 { return "Last updated 1 hour ago" }
        if hours < 24 { return "Last updated \(hours) hours ago" }
        let days = hours / 24
        return days == 1 ? "Last updated yesterday" : "Last updated \(days) days ago"
    }

    /// What to say when cached data is older than its screen's ceiling.
    ///
    /// A board past its ceiling is still worth showing — a timetable is better
    /// than a blank screen — but it must stop implying live accuracy.
    static func staleBoardNotice(secondsAgo seconds: Double) -> String {
        "\(lastUpdated(secondsAgo: seconds)) · times may have changed"
    }

    /// "reported 2 min ago" — how fresh a live position is.
    ///
    /// A stale position is still shown (a quiet feed isn't a vanished train),
    /// but its age has to be said out loud rather than implied to be current.
    static func reportedAgo(seconds: Double) -> String {
        let minutes = Int((seconds / 60).rounded())
        if minutes <= 0 { return "reported just now" }
        if minutes == 1 { return "reported 1 min ago" }
        if minutes < 60 { return "reported \(minutes) min ago" }
        let hours = minutes / 60
        return hours == 1 ? "reported 1 hour ago" : "reported \(hours) hours ago"
    }
}
