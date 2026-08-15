import Foundation

/// What VoiceOver reads for the app's data rows.
///
/// Kept as pure functions rather than inline `.accessibilityLabel` modifiers
/// for two reasons: they're testable without hosting a view, and composing the
/// sentence deliberately is the whole point. `.accessibilityElement(children:
/// .combine)` on its own reads the struck-through scheduled time and the status
/// pill in whatever order the layout happens to put them, which is worse than
/// the ungrouped version.
///
/// The rule throughout: say the most actionable thing, and never let a colour
/// or an icon be the only carrier of meaning (PRODUCT.md, WCAG 2.2 AA).
enum AccessibleLabels {
    /// One departure-board row.
    ///
    /// Reads as: "07:31 to Brighton, 4 minutes late, was 07:27. Platform 12,
    /// changed. Southern. Near Clapham Junction."
    static func departure(_ departure: Departure) -> String {
        var parts: [String] = []

        parts.append("\(departure.effectiveTime.hhmm) to \(departure.destinationName)")

        parts.append(
            StatusFormatting.departureLabel(
                status: departure.status,
                delayMinutes: departure.delayMinutes,
                hasLive: departure.hasLive
            )
        )

        // A retimed train: say what it was, since the row shows both.
        if departure.isRetimed {
            parts.append("was \(departure.scheduled.hhmm)")
        }

        if let platform = departure.platform {
            // The platform *change* is the single most actionable thing on a
            // board, and it was previously an unlabelled icon inside an
            // unlabelled row — completely silent to VoiceOver.
            parts.append(
                departure.platformChanged
                    ? "Platform \(platform), changed"
                    : "Platform \(platform)"
            )
        } else if departure.platformChanged {
            parts.append("Platform changed")
        }

        if let operatorName = departure.operatorName {
            parts.append(operatorName)
        }

        if let count = departure.coachCount {
            parts.append("\(count) coaches")
        }

        if let reason = departure.reason {
            parts.append(reason)
        }

        if let position = departure.position {
            var line = position.label
            if position.stale == true, let ago = position.reportedAgoSeconds {
                line += ", \(StatusFormatting.reportedAgo(seconds: ago))"
            }
            parts.append(line)
        }

        return parts.joined(separator: ". ")
    }

    /// One live train on the map.
    ///
    /// The marker carries its meaning in colour alone, and its `Annotation`
    /// label was `headcode ?? ""` — an empty string, so VoiceOver saw an
    /// unlabelled tappable element on the screen where status matters most.
    static func liveTrain(_ train: LiveTrain) -> String {
        var parts: [String] = []

        if let headcode = train.headcode {
            parts.append("Train \(headcode)")
        } else {
            parts.append("Train")
        }

        if let destination = train.destName {
            parts.append("to \(destination)")
        }

        parts.append(train.latenessLabel)

        if let at = train.atName {
            parts.append("near \(at)")
        }

        if train.isStale, let ago = train.reportedAgoSeconds {
            parts.append(StatusFormatting.reportedAgo(seconds: ago))
        }

        return parts.joined(separator: ", ")
    }

    /// One calling point on a service.
    ///
    /// Progress through the journey was conveyed entirely by an icon and its
    /// colour, so VoiceOver got the station and time but no sense of where the
    /// train actually is.
    static func call(
        stationName: String,
        time: String,
        state: CallState,
        platform: String?
    ) -> String {
        var parts = ["\(stationName), \(time)", state.spokenDescription]
        if let platform { parts.append("platform \(platform)") }
        return parts.joined(separator: ", ")
    }

    /// Where a train is relative to a calling point.
    enum CallState {
        case departed
        case current
        case upcoming
        case cancelled

        var spokenDescription: String {
            switch self {
            case .departed: return "departed"
            case .current: return "the train is here now"
            case .upcoming: return "still to come"
            case .cancelled: return "cancelled"
            }
        }
    }
}
