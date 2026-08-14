import Foundation

/// Links that open the app.
///
/// Two shapes arrive here: the custom `signaller://` scheme (magic-link
/// callbacks, notification taps) and `https://<host>/auth/...` universal links,
/// which iOS routes here once the app-site-association file is in place.
enum DeepLink: Equatable {
    /// A magic-link sign-in token to exchange for a session.
    case authToken(String)
    /// Open a station's departure board.
    case board(crs: String)
    /// Open one train's detail.
    case service(id: String)
    /// Open the commute dashboard — where alert notifications land.
    case commute

    init?(url: URL) {
        // signaller://auth?token=… — and the universal-link form /auth/...
        let isCustomScheme = url.scheme == "signaller"
        let host = url.host()
        let firstPathComponent = url.pathComponents.first(where: { $0 != "/" })

        // For signaller://auth the target is the host; for https://…/auth it's
        // the first path component.
        let route = isCustomScheme ? (host ?? firstPathComponent) : firstPathComponent

        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            query.first(where: { $0.name == name })?.value
        }

        switch route {
        case "auth":
            guard let token = value("token"), !token.isEmpty else { return nil }
            self = .authToken(token)
        case "boards":
            // signaller://boards?crs=WAT, or /boards/WAT
            let crs = value("crs") ?? url.pathComponents.last
            guard let crs, crs.count == 3 else { return nil }
            self = .board(crs: crs.uppercased())
        case "services":
            guard let id = value("id") ?? url.pathComponents.last, !id.isEmpty else { return nil }
            self = .service(id: id)
        case "commute":
            self = .commute
        default:
            return nil
        }
    }
}
