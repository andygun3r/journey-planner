import Foundation
import Observation

/// Drives the Plan screen.
///
/// `Phase` exists to separate three outcomes the old code conflated: a
/// successful plan with results, a successful plan with *no* results, and a
/// failed request. Only the last is an error; the middle one used to render as
/// a blank screen.
@Observable
@MainActor
final class PlanModel {
    enum Phase {
        case idle
        case loading
        case results([Journey])
        /// The API answered, and there was nothing to show.
        case empty(reason: String?)
        case failed(APIError)
    }

    var from: JourneyEndpoint?
    var to: JourneyEndpoint?
    /// nil means "now", which is also what turns on live enrichment server-side.
    var departAt: Date?
    private(set) var phase: Phase = .idle

    var canSearch: Bool {
        guard let from, let to else { return false }
        return from != to
    }

    func swapEnds() {
        let held = from
        from = to
        to = held
    }

    func search(using api: APIClient) async {
        guard let from, let to else { return }
        phase = .loading
        do {
            let response = try await api.plan(
                from: from.queryValue,
                to: to.queryValue,
                when: departAt
            )
            // HTTP 200 with ok:false is "no journeys", not a failure — and an
            // ok:true with an empty list means the same thing to the user.
            guard response.ok, let journeys = response.journeys, !journeys.isEmpty else {
                phase = .empty(reason: response.reason ?? "no-journeys")
                return
            }
            phase = .results(journeys)
        } catch let error as APIError {
            phase = .failed(error)
        } catch {
            phase = .failed(.transport(error.localizedDescription))
        }
    }
}
