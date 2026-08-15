import Foundation
import Testing
@testable import Signaller

/// The SSE wire format, driven line by line.
///
/// These matter because the failure mode is silence: a parser that drops the
/// wrong line doesn't crash, it just stops showing live data, which looks
/// identical to a quiet feed.
@Suite("SSE frame parsing")
struct SSEClientTests {
    /// Feeds lines through the real parser and collects what it emits.
    private func frames(_ lines: [String]) -> [SSEEvent] {
        var parser = SSEClient.FrameParser()
        return lines.compactMap { parser.consume($0) }
    }

    @Test("parses a simple frame")
    func simpleFrame() {
        let events = frames(["event: ready", "data: {}", ""])
        #expect(events.count == 1)
        #expect(events.first?.name == "ready")
        #expect(events.first?.data == "{}")
    }

    @Test("ignores heartbeat comments")
    func ignoresHeartbeat() {
        // The server sends ": ping" every 25s. Treating it as data would
        // corrupt the following frame.
        let events = frames([
            "event: ready", "data: {}", "",
            ": ping", "",
            "event: position", "data: {\"lat\":51.5}", "",
        ])
        #expect(events.map(\.name) == ["ready", "position"])
        #expect(events.last?.data == "{\"lat\":51.5}")
    }

    @Test("joins multi-line data per the spec")
    func multiLineData() {
        let events = frames(["event: x", "data: first", "data: second", ""])
        #expect(events.first?.data == "first\nsecond")
    }

    @Test("accepts fields with no space after the colon")
    func noSpaceAfterColon() {
        let events = frames(["event:tight", "data:{}", ""])
        #expect(events.first?.name == "tight")
        #expect(events.first?.data == "{}")
    }

    @Test("a frame with no event name defaults to message")
    func defaultsToMessage() {
        let events = frames(["data: {}", ""])
        #expect(events.first?.name == "message")
    }

    @Test("blank lines between frames emit nothing")
    func blankLinesAreHarmless() {
        #expect(frames(["", "", ""]).isEmpty)
    }

    @Test("an unterminated frame is not emitted until its blank line")
    func waitsForTerminator() {
        // A frame split across two network chunks arrives as lines with no
        // trailing blank yet — it must be held, not emitted half-built.
        var parser = SSEClient.FrameParser()
        #expect(parser.consume("event: snapshot") == nil)
        #expect(parser.consume("data: {\"count\":2}") == nil)
        let event = parser.consume("")
        #expect(event?.name == "snapshot")
        #expect(event?.data == "{\"count\":2}")
    }

    @Test("the unavailable sentinel is recognised as its own event")
    func unavailableSentinel() {
        // Sent with HTTP 200 when REDIS_URL is unset. It means "live streaming
        // is off for this deployment" — the caller polls instead, permanently,
        // rather than reconnecting forever.
        let events = frames(["event: unavailable", "data: {}", ""])
        #expect(events.first?.name == "unavailable")
    }
}

@Suite("Live channel state")
struct LiveChannelStateTests {
    @Test("polling is needed unless the stream is up")
    func needsPolling() {
        #expect(LiveChannel.State.pollingFallback.needsPolling)
        #expect(LiveChannel.State.idle.needsPolling)
        #expect(LiveChannel.State.reconnecting(attempt: 2).needsPolling)
        #expect(!LiveChannel.State.live.needsPolling)
        // Connecting is optimistic on purpose: starting a poll for the second
        // it takes to open would double every request on a healthy connection.
        #expect(!LiveChannel.State.connecting.needsPolling)
    }
}
