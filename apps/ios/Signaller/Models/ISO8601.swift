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
    private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Parses an ISO-8601 instant, with or without fractional seconds.
    static func date(from value: String) -> Date? {
        withFractionalSeconds.date(from: value) ?? plain.date(from: value)
    }

    /// Serialises an instant for query parameters (e.g. `/api/journeys?when=`).
    static func string(from date: Date) -> String {
        plain.string(from: date)
    }
}

extension JSONDecoder {
    /// A decoder that turns the backend's ISO strings into real `Date`s, so
    /// models never hold a `String` that merely looks like a time.
    static var signaller: JSONDecoder {
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
    }
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
