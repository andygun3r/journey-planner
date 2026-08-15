import Foundation

/// What can go wrong talking to the backend.
///
/// The distinction that matters: the API answering "no journeys found" is not
/// the same as the API being unreachable, and the user needs different words
/// for each. The old client treated every HTTP status from 200 to 599 as
/// success and fed the body to the decoder, so a 503 surfaced as a decode
/// failure labelled "couldn't reach the backend" — misleading in both
/// directions.
enum APIError: Error, LocalizedError, Equatable {
    /// The base URL is missing or malformed — a build-configuration problem.
    case badURL
    /// Couldn't reach the server at all (offline, DNS, timeout, TLS).
    case transport(String)
    /// The server answered, and said no. `reason` is the backend's own machine
    /// -readable code (`engine-offline`, `unknown-station`, …) when it sent one.
    case http(status: Int, reason: String?)
    /// Reached the server, but couldn't make sense of the reply.
    case decoding(String)
    /// Signed out, or the session expired.
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "The app is pointed at an invalid backend address."
        case .transport:
            return "Couldn't reach Signaller. Check your connection."
        case let .http(status, reason):
            return Self.message(forReason: reason, status: status)
        case .decoding:
            return "Signaller sent something this app didn't understand."
        case .unauthorized:
            return "You need to sign in again."
        }
    }

    /// Maps the backend's `reason` codes to something a person can act on.
    /// Codes come from the route handlers in `apps/web/app/api/`.
    private static func message(forReason reason: String?, status: Int) -> String {
        switch reason {
        case "engine-offline":
            return "The routing engine is offline right now. Try again shortly."
        case "unknown-station":
            return "That station wasn't recognised."
        case "bad-request":
            return "That search wasn't valid."
        case "not-configured":
            return "This feature isn't set up on the server."
        case "unavailable":
            return "That service isn't available right now."
        default:
            return status >= 500
                ? "Signaller is having trouble. Try again shortly."
                : "That request couldn't be completed."
        }
    }

    /// True when retrying might plausibly work — drives whether the UI offers
    /// a "Try again" button.
    var isRetryable: Bool {
        switch self {
        case .transport:
            return true
        case let .http(status, _):
            return status >= 500 || status == 408 || status == 429
        case .badURL, .decoding, .unauthorized:
            return false
        }
    }
}

/// The `{ ok: false, reason: "..." }` envelope the API returns on failure.
/// Decoded opportunistically so `reason` can reach `APIError.http`.
struct APIFailureEnvelope: Decodable {
    let ok: Bool?
    let reason: String?
    let error: String?
}

/// For endpoints whose success body is just `{ ok: true }`.
struct EmptyOK: Decodable {
    let ok: Bool
}
