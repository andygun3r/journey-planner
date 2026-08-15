import Foundation

/// Date parsing for everything the backend sends.
///
/// The backend is not consistent about fractional seconds, and it can't easily
/// be: board `generatedAt` comes from `new Date().toISOString()`, which *always*
/// emits milliseconds (`2026-08-14T07:31:00.123Z`), while timetable-derived
/// departure times often don't. A plain `ISO8601DateFormatter` rejects the
/// former outright, so every board timestamp silently fell through to a
/// substring fallback and rendered as "2026-" where a time should have been.
///
/// Parse with fractional seconds first — that's the common case — then plain.
enum ISO8601 {
    /// `ISO8601DateFormatter` isn't `Sendable`, but these two are configured
    /// once at init and only ever read afterwards — `date(from:)` and
    /// `string(from:)` don't mutate. `nonisolated(unsafe)` states that
    /// deliberately rather than paying for a lock or rebuilding a formatter on
    /// every call, which is what the previous computed-property version
    /// effectively did.
    nonisolated(unsafe) private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Parses an ISO-8601 instant, with or without fractional seconds.
    static func date(from value: String) -> Date? {
        withFractionalSeconds.date(from: value) ?? plain.date(from: value)
    }

    /// Serialises an instant for query parameters (e.g. `/api/journeys?when=`).
    ///
    /// Whole seconds by default, which is what the API expects. The cache asks
    /// for fractional seconds so a round trip preserves the exact instant.
    static func string(from date: Date, withFractionalSeconds: Bool = false) -> String {
        withFractionalSeconds ? self.withFractionalSeconds.string(from: date) : plain.string(from: date)
    }
}

extension JSONDecoder {
    /// A decoder that turns the backend's ISO strings into real `Date`s, so
    /// models never hold a `String` that merely looks like a time.
    ///
    /// `let`, not `var`: as a computed property this built a fresh decoder and
    /// installed a new closure on *every* access — once per API response, and
    /// once per SSE event, which on the national train feed is several times a
    /// second.
    static let signaller: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = ISO8601.date(from: raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Not an ISO-8601 instant: \(raw)"
                )
            }
            return date
        }
        return decoder
    }()
}

extension JSONEncoder {
    /// The mirror of `JSONDecoder.signaller`, so a cached response round-trips
    /// back to exactly what the server sent.
    ///
    /// Encodes with fractional seconds because that's what the backend emits
    /// for anything it generates itself, and the decoder tries that form first.
    static let signaller: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.string(from: date, withFractionalSeconds: true))
        }
        return encoder
    }()
}

extension Date {
    /// "07:31" — 24-hour, no AM/PM, matching the departure-board convention.
    var hhmm: String {
        formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }
}

extension Optional where Wrapped == Date {
    /// "07:31", or "--:--" when there is genuinely no time to show.
    ///
    /// Never renders a partial or guessed value: an unparseable timestamp is
    /// missing data, and on a live rail product that has to look missing.
    var hhmmOrDash: String { self?.hhmm ?? "--:--" }
}
