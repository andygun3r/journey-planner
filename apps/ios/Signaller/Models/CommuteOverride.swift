import Foundation

/// A per-date change to a commute.
///
/// "I'm working from home on Thursday" is the single most phone-shaped commute
/// action there is — decided in bed the night before, one tap — and it was
/// web-only. Mirrors `OverrideInput` in `apps/web/lib/commute-overrides.ts`.
struct CommuteOverride: Codable, Identifiable, Hashable {
    /// `YYYY-MM-DD`. The date *is* the identity: one override per day.
    let date: String
    /// No commute at all that day.
    let skipped: Bool
    /// Working somewhere other than the usual place.
    let workCrs: String?
    let workLabel: String?
    let amWindowStart: String?
    let amWindowEnd: String?
    let pmWindowStart: String?
    let pmWindowEnd: String?
    let note: String?

    var id: String { date }

    /// True when this override changes nothing — the UI treats that as "no
    /// override" rather than showing an empty exception.
    var isEmpty: Bool {
        !skipped && workCrs == nil && note == nil
            && amWindowStart == nil && amWindowEnd == nil
            && pmWindowStart == nil && pmWindowEnd == nil
    }

    /// What the day looks like at a glance.
    var summary: String {
        if skipped { return "Not commuting" }
        if let workLabel { return "Working from \(workLabel)" }
        if let note, !note.isEmpty { return note }
        if amWindowStart != nil || pmWindowStart != nil { return "Different times" }
        return "Changed"
    }
}

struct OverridesResponse: Codable {
    let ok: Bool
    let overrides: [CommuteOverride]
}

/// Whether an override applies to one date or to every future occurrence of
/// that weekday — the calendar's this-day / all-future choice.
/// Exactly the values the route accepts — it rejects anything else with a 400.
enum OverrideScope: String, CaseIterable {
    case thisDay = "date"
    case futureWeekdays = "future"

    var label: String {
        switch self {
        case .thisDay: return "This day only"
        case .futureWeekdays: return "Every week"
        }
    }
}

/// A date range where commute alerts are paused.
///
/// Mirrors `HolidayInput` in `packages/shared/src/commute.ts`, including the
/// rule that `endDate` must not precede `startDate` — enforced client-side too
/// so the user finds out before the round trip.
struct Holiday: Codable, Identifiable, Hashable {
    let id: String
    let startDate: String
    let endDate: String
    let label: String?

    var dateRangeLabel: String {
        startDate == endDate ? startDate.prettyDate : "\(startDate.prettyDate) – \(endDate.prettyDate)"
    }
}

struct HolidaysResponse: Codable {
    let ok: Bool
    let holidays: [Holiday]
}

extension String {
    /// "2026-08-15" → "15 Aug 2026". Falls back to the raw value rather than
    /// inventing a date it couldn't parse.
    var prettyDate: String {
        let parts = split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              let date = Calendar.current.date(
                from: DateComponents(year: year, month: month, day: day)
              )
        else { return self }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    /// `YYYY-MM-DD`, the format every commute date endpoint expects.
    static func isoDate(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
