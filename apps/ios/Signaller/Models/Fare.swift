import Foundation

/// Indicative fares between two stations.
///
/// `/api/fares` exists solely for this client — its own comment says the web
/// app renders fares server-side and the route is there "purely to give the
/// native app the same figures" — and until now nothing called it.
///
/// **Indicative is the operative word.** Cheapest standard single/return from
/// the DTD RJFAF feed, honouring station clusters. No railcards, no routeing
/// guide, no advance fares. The UI has to say so rather than let a number look
/// like a quote.
struct FaresResponse: Codable {
    let ok: Bool
    let fare: IndicativeFare?
}

struct IndicativeFare: Codable, Equatable {
    /// Cheapest standard single, in pence.
    let singlePence: Int?
    /// Cheapest standard return, in pence.
    let returnPence: Int?

    /// True when there's nothing worth showing — the feed has no flow for this
    /// pair, which is common for journeys that need a routeing-guide lookup.
    var isEmpty: Bool { singlePence == nil && returnPence == nil }

    var singleLabel: String? { Self.money(singlePence) }
    var returnLabel: String? { Self.money(returnPence) }

    /// "£12.40". Whole pounds still show pence, because a fare that reads
    /// "£12" invites the question of whether it's been rounded.
    static func money(_ pence: Int?) -> String? {
        guard let pence else { return nil }
        return "£\(String(format: "%.2f", Double(pence) / 100))"
    }
}
