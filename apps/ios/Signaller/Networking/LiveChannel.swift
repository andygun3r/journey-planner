import Foundation
import Observation

/// Keeps one SSE stream alive for as long as a screen wants it.
///
/// Owns the three things every caller would otherwise reinvent: reconnecting
/// with backoff, standing down when the app goes to the background, and
/// falling back to polling when the server says live streaming is off.
@Observable
@MainActor
final class LiveChannel {
    enum State: Equatable {
        case idle
        case connecting
        case live
        /// Server has no Redis: polling is the only option, permanently.
        case pollingFallback
        /// Dropped; a reconnect is scheduled.
        case reconnecting(attempt: Int)
    }

    private(set) var state: State = .idle

    private let path: String
    private let query: [URLQueryItem]
    private let api: APIClient
    private let auth: AuthStore?
    private let client = SSEClient()
    private var task: Task<Void, Never>?

    /// Called for every event the stream delivers.
    private let onEvent: (SSEEvent) -> Void

    /// Backoff bounds. Jittered so a server restart doesn't bring every client
    /// back in the same instant.
    private static let minDelay: Double = 1
    private static let maxDelay: Double = 30

    init(
        path: String,
        query: [URLQueryItem] = [],
        api: APIClient,
        auth: AuthStore? = nil,
        onEvent: @escaping (SSEEvent) -> Void
    ) {
        self.path = path
        self.query = query
        self.api = api
        self.auth = auth
        self.onEvent = onEvent
    }

    // No deinit cancellation: `task` is main-actor isolated and deinit isn't,
    // so it can't be touched from there. Callers stop the channel explicitly
    // from `onDisappear` / `scenePhase`, which is also the only place that
    // knows whether a stream should outlive a particular view.

    /// Opens the stream. Safe to call repeatedly — a running channel is left alone.
    func start() {
        guard task == nil else { return }
        // Once the server has said "unavailable", reconnecting is pointless.
        guard state != .pollingFallback else { return }
        task = Task { await run() }
    }

    /// Closes the stream. Call when a screen disappears or the app backgrounds.
    func stop() {
        task?.cancel()
        task = nil
        if state != .pollingFallback { state = .idle }
    }

    private func run() async {
        var attempt = 0

        while !Task.isCancelled {
            state = attempt == 0 ? .connecting : .reconnecting(attempt: attempt)

            do {
                guard let request = makeRequest() else {
                    state = .idle
                    return
                }

                var sawEvent = false
                for try await element in client.events(for: request) {
                    if Task.isCancelled { break }
                    switch element {
                    case let .event(event):
                        sawEvent = true
                        // `ready` only confirms the stream opened.
                        if event.name == "ready" {
                            state = .live
                            attempt = 0
                            continue
                        }
                        state = .live
                        onEvent(event)

                    case let .ended(termination):
                        if termination == .unavailable {
                            // Live streaming is off for this deployment. Stop
                            // trying; the caller polls from here on.
                            state = .pollingFallback
                            return
                        }
                    }
                }

                // A clean end still means we're disconnected — reconnect, but
                // reset backoff if the connection had been working.
                if sawEvent { attempt = 0 }
            } catch is CancellationError {
                return
            } catch APIError.unauthorized {
                // No amount of retrying fixes a missing session.
                state = .idle
                return
            } catch {
                // Fall through to the backoff below.
            }

            guard !Task.isCancelled else { return }

            attempt += 1
            let backoff = min(Self.maxDelay, Self.minDelay * pow(2, Double(attempt - 1)))
            let jittered = backoff * Double.random(in: 0.7...1.3)
            state = .reconnecting(attempt: attempt)
            try? await Task.sleep(for: .seconds(jittered))
        }
    }

    private func makeRequest() -> URLRequest? {
        guard let url = URL(string: path, relativeTo: api.baseURL),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        else { return nil }
        if !query.isEmpty { components.queryItems = query }
        guard let final = components.url else { return nil }

        var request = URLRequest(url: final)
        if let token = auth?.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

extension LiveChannel.State {
    /// True when the caller should be running its own poll timer: either the
    /// server has no live streaming, or we're currently disconnected.
    var needsPolling: Bool {
        switch self {
        case .pollingFallback, .reconnecting, .idle: return true
        case .live, .connecting: return false
        }
    }
}
