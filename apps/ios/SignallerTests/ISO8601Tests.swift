import Foundation
import Testing
@testable import Signaller

/// The regression that mattered most.
///
/// A plain `ISO8601DateFormatter` rejects fractional seconds. The backend's
/// board `generatedAt` comes from `new Date().toISOString()`, which *always*
/// emits milliseconds, so every board timestamp fell through to a substring
/// fallback and rendered as "2026-" where a time should have been. It looked
/// like a formatting quirk, not a parse failure, which is why it survived.
@Suite("ISO8601 parsing")
struct ISO8601Tests {
    /// 2026-08-14T07:31:00Z as a Unix timestamp, built rather than hardcoded so
    /// the expectation is readable.
    private static let reference: Date = {
        var components = DateComponents()
        components.year = 2026; components.month = 8; components.day = 14
        components.hour = 7; components.minute = 31; components.second = 0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: components)!
    }()

    @Test("parses fractional seconds — the exact shape /api/boards sends")
    func fractionalSeconds() throws {
        let date = try #require(ISO8601.date(from: "2026-08-14T07:31:00.123Z"))
        #expect(abs(date.timeIntervalSince(Self.reference) - 0.123) < 0.001)
    }

    @Test("parses instants without fractional seconds")
    func withoutFractionalSeconds() throws {
        let date = try #require(ISO8601.date(from: "2026-08-14T07:31:00Z"))
        #expect(date == Self.reference)
    }

    @Test("both forms of the same instant parse equal")
    func equivalentForms() throws {
        let plain = try #require(ISO8601.date(from: "2026-08-14T07:31:00Z"))
        let fractional = try #require(ISO8601.date(from: "2026-08-14T07:31:00.000Z"))
        #expect(plain == fractional)
    }

    @Test("rejects what isn't a timestamp")
    func rejectsGarbage() {
        #expect(ISO8601.date(from: "not-a-date") == nil)
        #expect(ISO8601.date(from: "") == nil)
        #expect(ISO8601.date(from: "2026-08-14") == nil)
    }

    @Test("missing time shows --:-- rather than a partial string")
    func dashesForMissing() {
        // The old fallback printed the first five characters of the raw value,
        // so an ISO date rendered as "2026-". No time must never look like a time.
        let missing: Date? = nil
        #expect(missing.hhmmOrDash == "--:--")
    }

    @Test("decoder turns both timestamp forms into real Dates")
    func decoderStrategy() throws {
        struct Row: Decodable { let at: Date }
        let fractional = try JSONDecoder.signaller.decode(
            Row.self, from: Data(#"{"at":"2026-08-14T07:31:00.123Z"}"#.utf8)
        )
        let plain = try JSONDecoder.signaller.decode(
            Row.self, from: Data(#"{"at":"2026-08-14T07:31:00Z"}"#.utf8)
        )
        #expect(abs(fractional.at.timeIntervalSince(plain.at) - 0.123) < 0.001)
    }

    @Test("decoding fails loudly on a malformed timestamp")
    func decoderRejectsGarbage() {
        struct Row: Decodable { let at: Date }
        #expect(throws: DecodingError.self) {
            try JSONDecoder.signaller.decode(Row.self, from: Data(#"{"at":"whenever"}"#.utf8))
        }
    }
}
