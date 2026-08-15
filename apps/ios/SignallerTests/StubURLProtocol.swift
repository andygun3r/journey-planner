import Foundation
@testable import Signaller

/// Serves canned responses to `URLSession`, so view models can be tested
/// against real `APIClient` behaviour without a network.
///
/// `APIClient.init` already took an injectable `URLSession` — the seam existed
/// and nothing used it, which is why the error taxonomy in `send(_:)` (the
/// most consequential logic in the app) had no tests at all.
///
/// Routes are keyed per stub *instance*, not globally: `.serialized` orders
/// tests within a suite, but suites run concurrently, so a single shared route
/// table meant two suites reset each other mid-request. Each test makes its own
/// `Stub`, and the session carries its id in a header.
final class StubURLProtocol: URLProtocol {
    /// What to do when a request arrives.
    enum Outcome {
        /// A real HTTP response with a body.
        case json(String, status: Int = 200)
        /// Raw bytes, for testing a non-JSON error page.
        case body(String, status: Int, contentType: String)
        /// A transport failure — no response at all.
        case failure(URLError.Code)
    }

    /// One test's routes and recorded traffic.
    final class Stub: @unchecked Sendable {
        let id = UUID().uuidString
        private let lock = NSLock()
        private var routes: [(match: String, outcome: Outcome)] = []
        private var recorded: [URLRequest] = []

        init() { StubURLProtocol.register(self) }

        /// Registers an outcome for any request whose path contains `match`.
        func on(_ match: String, _ outcome: Outcome) {
            lock.lock(); defer { lock.unlock() }
            routes.append((match, outcome))
        }

        /// Convenience: serve a fixture file for a path.
        func onFixture(_ match: String, _ name: String) throws {
            on(match, .json(String(decoding: try Fixtures.data(name), as: UTF8.self)))
        }

        /// A session whose requests this stub answers.
        func session() -> URLSession {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [StubURLProtocol.self]
            config.httpAdditionalHeaders = [Self.headerName: id]
            return URLSession(configuration: config)
        }

        /// An `APIClient` pointed at a fixed host, backed by this stub.
        @MainActor
        func client(auth: AuthStore? = nil) -> APIClient {
            APIClient(baseURL: URL(string: "https://stub.invalid")!, auth: auth, session: session())
        }

        var requestedPaths: [String] {
            lock.lock(); defer { lock.unlock() }
            return recorded.compactMap { $0.url?.path }
        }

        var lastRequest: URLRequest? {
            lock.lock(); defer { lock.unlock() }
            return recorded.last
        }

        fileprivate func outcome(for path: String) -> Outcome? {
            lock.lock(); defer { lock.unlock() }
            return routes.first { path.contains($0.match) }?.outcome
        }

        fileprivate func record(_ request: URLRequest) {
            lock.lock(); defer { lock.unlock() }
            recorded.append(request)
        }

        static let headerName = "X-Stub-Id"
    }

    // MARK: - Registry

    nonisolated(unsafe) private static var stubs: [String: Stub] = [:]
    private static let registryLock = NSLock()

    private static func register(_ stub: Stub) {
        registryLock.lock(); defer { registryLock.unlock() }
        stubs[stub.id] = stub
    }

    private static func stub(for request: URLRequest) -> Stub? {
        guard let id = request.value(forHTTPHeaderField: Stub.headerName) else { return nil }
        registryLock.lock(); defer { registryLock.unlock() }
        return stubs[id]
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        guard let stub = Self.stub(for: request) else {
            fail("StubURLProtocol: request carried no stub id")
            return
        }
        stub.record(request)

        guard let outcome = stub.outcome(for: path) else {
            // An unstubbed path is a test bug, not a 404 — say so loudly
            // rather than letting the view model see a plausible failure.
            fail("StubURLProtocol: no route for \(path)")
            return
        }

        switch outcome {
        case let .json(body, status):
            respond(body: Data(body.utf8), status: status, contentType: "application/json")
        case let .body(body, status, contentType):
            respond(body: Data(body.utf8), status: status, contentType: contentType)
        case let .failure(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    private func fail(_ message: String) {
        client?.urlProtocol(
            self,
            didFailWithError: URLError(.unsupportedURL, userInfo: [NSLocalizedDescriptionKey: message])
        )
    }

    private func respond(body: Data, status: Int, contentType: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": contentType]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
