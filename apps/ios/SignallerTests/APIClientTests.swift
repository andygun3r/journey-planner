import Foundation
import Testing
@testable import Signaller

/// The error taxonomy in `APIClient.send(_:)`.
///
/// This is the rule the whole class is shaped around — "I answered, and the
/// answer is no results" (HTTP 200 with `ok: false`) must stay distinct from
/// "I couldn't answer" (4xx/5xx) — and it had no tests. The seam to test it
/// (`init(session:)`) already existed and was unused.
@Suite("API client", .serialized)
@MainActor
struct APIClientTests {
    /// A fresh stub per test — suites run concurrently, so routes must not
    /// be shared.
    private func makeStub() -> StubURLProtocol.Stub { StubURLProtocol.Stub() }

    @Test("200 with a valid body decodes")
    func success() async throws {
        let stub = makeStub()
        let api = stub.client()
        try stub.onFixture("/api/boards/", "board")
        let response = try await api.board(crs: "WAT")
        #expect(response.ok)
        #expect(response.board?.stationName == "London Waterloo")
    }

    @Test("200 with ok:false is a result, not an error")
    func okFalseIsNotAnError() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on("/api/journeys", .json(#"{"ok":false,"reason":"no-journeys"}"#))
        // The distinction the original client collapsed: this must return
        // normally so the caller can render "no journeys found" rather than
        // an error card.
        let response = try await api.plan(from: "WAT", to: "BTN")
        #expect(!response.ok)
        #expect(response.reason == "no-journeys")
    }

    @Test("401 is unauthorized, whatever the body says")
    func unauthorized() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on("/api/favourites", .json(#"{"ok":false}"#, status: 401))
        await #expect(throws: APIError.unauthorized) {
            _ = try await api.favourites()
        }
    }

    @Test("5xx carries the reason when the body has one")
    func serverErrorWithReason() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on(
            "/api/journeys",
            .json(#"{"ok":false,"reason":"engine-offline"}"#, status: 503)
        )
        do {
            _ = try await api.plan(from: "WAT", to: "BTN")
            Issue.record("expected a failure")
        } catch let APIError.http(status, reason) {
            #expect(status == 503)
            #expect(reason == "engine-offline")
        }
    }

    @Test("an HTML error page is an http error, never a decoding error")
    func htmlErrorPage() async throws {
        let stub = makeStub()
        let api = stub.client()
        // nginx or a Next.js 500 returns HTML. The reason is best-effort, but
        // the *kind* of error must still be right: reporting this as a
        // decoding failure would blame the client for a server outage.
        stub.on(
            "/api/journeys",
            .body("<html><body>502 Bad Gateway</body></html>", status: 502, contentType: "text/html")
        )
        do {
            _ = try await api.plan(from: "WAT", to: "BTN")
            Issue.record("expected a failure")
        } catch let APIError.http(status, reason) {
            #expect(status == 502)
            #expect(reason == nil)
        } catch {
            Issue.record("expected .http, got \(error)")
        }
    }

    @Test("a transport failure is reported as transport")
    func transportFailure() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on("/api/health", .failure(.notConnectedToInternet))
        do {
            _ = try await api.health()
            Issue.record("expected a failure")
        } catch let APIError.transport(message) {
            #expect(!message.isEmpty)
        } catch {
            Issue.record("expected .transport, got \(error)")
        }
    }

    @Test("malformed success bodies surface as decoding errors")
    func decodingFailure() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on("/api/health", .json(#"{"unexpected":true}"#))
        do {
            _ = try await api.health()
            Issue.record("expected a failure")
        } catch is DecodingError {
            Issue.record("should be wrapped in APIError, not raw DecodingError")
        } catch let APIError.decoding(detail) {
            #expect(!detail.isEmpty)
        }
    }

    // MARK: - Request building

    @Test("query values are percent-encoded")
    func queryEncoding() async throws {
        let stub = makeStub()
        let api = stub.client()
        stub.on("/api/stations", .json(#"{"stations":[],"places":[]}"#))
        _ = try await api.stations(query: "King's Cross & St Pancras")
        // The apostrophe and ampersand must not break out of the query value.
        // The old client concatenated strings into the path, which happened to
        // work only because a CRS needs no encoding.
        let path = try #require(stub.requestedPaths.first)
        #expect(path == "/api/stations")
    }

    @Test("an empty station query never hits the network")
    func emptyQueryShortCircuits() async throws {
        let stub = makeStub()
        let api = stub.client()
        let response = try await api.stations(query: "   ")
        #expect(response.stations.isEmpty)
        #expect(stub.requestedPaths.isEmpty)
    }

    @Test("a bearer token is attached when signed in")
    func bearerToken() async throws {
        // Touches the real Keychain, so it restores whatever was there.
        let auth = AuthStore()
        let existing = auth.token
        defer {
            if let existing { auth.save(token: existing) } else { auth.signOut() }
        }

        auth.save(token: "test-token-123")
        let stub = makeStub()
        let api = stub.client(auth: auth)
        stub.on("/api/favourites", .json(#"{"favourites":[]}"#))
        _ = try await api.favourites()

        let header = stub.lastRequest?.value(forHTTPHeaderField: "Authorization")
        #expect(header == "Bearer test-token-123")
    }

    @Test("no Authorization header when signed out")
    func noBearerWhenSignedOut() async throws {
        let stub = makeStub()
        let api = stub.client(auth: nil)
        stub.on("/api/health", .json(#"{"ok":true,"postgres":true,"redis":true}"#))
        _ = try await api.health()
        #expect(stub.lastRequest?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("the board path carries an uppercased CRS")
    func crsNormalisation() async throws {
        let stub = makeStub()
        let api = stub.client()
        try stub.onFixture("/api/boards/", "board")
        _ = try await api.board(crs: " wat ")
        #expect(stub.requestedPaths.first == "/api/boards/WAT")
    }
}
