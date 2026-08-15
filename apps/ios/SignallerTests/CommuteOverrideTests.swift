import Foundation
import Testing
@testable import Signaller

/// Dates and payload shapes for the commute write endpoints.
///
/// These routes validate strictly — a wrong scope value or a date that isn't
/// `YYYY-MM-DD` is a 400, not a silent default — so the values the client
/// sends are worth pinning down.
@Suite("Commute overrides")
struct CommuteOverrideTests {
    @Test("dates are formatted as the API demands")
    func isoDateFormat() {
        var components = DateComponents()
        components.year = 2026
        components.month = 8
        components.day = 5
        let date = try! #require(Calendar.current.date(from: components))
        // Zero-padded, which `\(month)` would not be — "2026-8-5" fails the
        // route's YYYY-MM-DD check.
        #expect(String.isoDate(from: date) == "2026-08-05")
    }

    @Test("scope values match exactly what the route accepts")
    func scopeRawValues() {
        // The route rejects anything that isn't one of these two.
        #expect(OverrideScope.thisDay.rawValue == "date")
        #expect(OverrideScope.futureWeekdays.rawValue == "future")
        #expect(OverrideScope.allCases.count == 2)
        #expect(OverrideScope.allCases.allSatisfy { !$0.label.isEmpty })
    }

    @Test("an override describes itself in words")
    func summaryWording() throws {
        func override(_ json: String) throws -> CommuteOverride {
            try JSONDecoder.signaller.decode(CommuteOverride.self, from: Data(json.utf8))
        }

        let skipped = try override(#"{"date":"2026-08-20","skipped":true}"#)
        #expect(skipped.summary == "Not commuting")
        #expect(!skipped.isEmpty)

        let elsewhere = try override(#"""
        {"date":"2026-08-20","skipped":false,"workCrs":"CLJ","workLabel":"Clapham Junction"}
        """#)
        #expect(elsewhere.summary.contains("Clapham Junction"))

        // An override that changes nothing must not render as an exception.
        let empty = try override(#"{"date":"2026-08-20","skipped":false}"#)
        #expect(empty.isEmpty)
    }

    @Test("the date is the identity")
    func dateIsIdentity() throws {
        let override = try JSONDecoder.signaller.decode(
            CommuteOverride.self,
            from: Data(#"{"date":"2026-08-20","skipped":true}"#.utf8)
        )
        // One override per day, so the date is what a ForEach keys on.
        #expect(override.id == "2026-08-20")
    }

    @Test("dates read as words, and fall back rather than inventing one")
    func prettyDates() {
        #expect("2026-08-15".prettyDate.contains("Aug"))
        #expect("2026-08-15".prettyDate.contains("2026"))
        // Garbage in must not become a plausible-looking date.
        #expect("not-a-date".prettyDate == "not-a-date")
        #expect("".prettyDate == "")
    }

    @Test("a holiday states its range")
    func holidayRange() throws {
        func holiday(_ json: String) throws -> Holiday {
            try JSONDecoder.signaller.decode(Holiday.self, from: Data(json.utf8))
        }

        let range = try holiday(#"""
        {"id":"h1","startDate":"2026-08-20","endDate":"2026-08-27","label":"Cornwall"}
        """#)
        #expect(range.dateRangeLabel.contains("–"))

        // A single day shouldn't read as "20 Aug – 20 Aug".
        let oneDay = try holiday(#"""
        {"id":"h2","startDate":"2026-08-20","endDate":"2026-08-20","label":null}
        """#)
        #expect(!oneDay.dateRangeLabel.contains("–"))
    }

    @Test("override responses decode")
    func responseDecoding() throws {
        let response = try JSONDecoder.signaller.decode(
            OverridesResponse.self,
            from: Data(#"""
            {"ok":true,"overrides":[
              {"date":"2026-08-20","skipped":true},
              {"date":"2026-08-21","skipped":false,"note":"Late start"}
            ]}
            """#.utf8)
        )
        #expect(response.overrides.count == 2)
        #expect(response.overrides[1].summary == "Late start")
    }
}
