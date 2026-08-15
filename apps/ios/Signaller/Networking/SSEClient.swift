import Foundation

/// One Server-Sent Event.
struct SSEEvent: Equatable {
    /// The `event:` name. Defaults to "message" per the SSE spec.
    let name: String
    /// Concatenated `data:` lines, newline-joined.
    let data: String
}

/// Reads a Server-Sent Events stream.
///
/// Hand-rolled rather than pulled from a dependency: the wire format the
/// backend emits is a small subset of the spec — `event:`, `data:` and `: ping`
/// comments — and `URLSession.bytes(for:)` already does the hard part.
///
/// The one non-obvious rule is `event: unavailable`. The server sends it, with
/// HTTP 200, when `REDIS_URL` isn't configured. That isn't an error and isn't
/// worth retrying: it means live streaming is off for the whole deployment, so
/// the caller should fall back to polling and stay there.
struct SSEClient {
    enum Termination: Equatable {
        /// The server told us live streaming is unavailable. Poll instead;
        /// don't reconnect.
        case unavailable
        /// The connection ended. Reconnecting is reasonable.
        case disconnected
    }

    enum Element: Equatable {
        case event(SSEEvent)
        case ended(Termination)
    }

    private let session: URLSession

    init(session: URLSession = .sseSession) {
        self.session = session
    }

    /// Accumulates `event:` / `data:` lines and emits a frame on each blank
    /// line.
    ///
    /// Split out from the read loop so it can be driven by a plain array of
    /// lines in tests — the alternative is a real socket, which makes the
    /// interesting cases (a frame split across chunks, a stray heartbeat)
    /// awkward to provoke.
    struct FrameParser {
        private var name: String?
        private var dataLines: [String] = []

        /// Feeds one line. Returns a frame when that line completes one.
        mutating func consume(_ line: String) -> SSEEvent? {
            // A blank line dispatches whatever has accumulated.
            if line.isEmpty {
                guard !dataLines.isEmpty || name != nil else { return nil }
                let event = SSEEvent(
                    name: name ?? "message",
                    data: dataLines.joined(separator: "\n")
                )
                name = nil
                dataLines.removeAll()
                return event
            }

            // ": ping" and friends are comments — the heartbeat that stops a
            // proxy closing an idle connection.
            if line.hasPrefix(":") { return nil }

            if let value = line.strippingFieldPrefix("event:") {
                name = value
            } else if let value = line.strippingFieldPrefix("data:") {
                dataLines.append(value)
            }
            // Other fields (id:, retry:) are unused by this backend.
            return nil
        }
    }

    /// Opens the stream and yields events until it ends or the task is cancelled.
    func events(for request: URLRequest) -> AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = request
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    // No stale stream from a cache.
                    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

                    let (bytes, response) = try await session.bytes(for: request)

                    guard let http = response as? HTTPURLResponse else {
                        throw APIError.transport("Malformed response")
                    }
                    if http.statusCode == 401 { throw APIError.unauthorized }
                    guard (200..<300).contains(http.statusCode) else {
                        throw APIError.http(status: http.statusCode, reason: nil)
                    }

                    var parser = FrameParser()

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard let event = parser.consume(line) else { continue }

                        if event.name == "unavailable" {
                            continuation.yield(.ended(.unavailable))
                            continuation.finish()
                            return
                        }
                        continuation.yield(.event(event))
                    }

                    continuation.yield(.ended(.disconnected))
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private extension String {
    /// Strips an SSE field prefix, plus the single optional space after the
    /// colon that the spec allows.
    func strippingFieldPrefix(_ prefix: String) -> String? {
        guard hasPrefix(prefix) else { return nil }
        var rest = dropFirst(prefix.count)
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }
}

extension URLSession {
    /// A session tuned for long-lived streams.
    ///
    /// The default 60s request timeout would kill a healthy connection between
    /// heartbeats; the server pings every 25s, so the timeout only needs to
    /// outlast that comfortably.
    static let sseSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = .infinity
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = true
        return URLSession(configuration: config)
    }()
}
