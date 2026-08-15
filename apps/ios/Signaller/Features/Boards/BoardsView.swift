import SwiftUI
import Observation

@Observable
@MainActor
final class BoardModel {
    enum Phase {
        case idle
        case loading
        case loaded(Board)
        case empty(reason: String?)
        case failed(APIError)
    }

    var station: JourneyEndpoint?
    private(set) var phase: Phase = .idle

    /// When the board on screen was stored, if it came from the cache.
    ///
    /// Non-nil means "this is what we had last time, not what's true now" —
    /// and the UI must say so out loud.
    private(set) var servedFromCache: Date?

    /// Only a station can have a departure board. Gates the button so a
    /// non-station selection can't produce a tap that does nothing.
    var canLoad: Bool {
        if case .station? = station { return true }
        return false
    }

    func load(using api: APIClient, cache: ResponseCache? = nil) async {
        guard case let .station(crs, _)? = station else {
            // Unreachable via the UI now that `canLoad` gates the button, but
            // a silent return here is what made the original bug invisible.
            phase = .empty(reason: "not-a-station")
            return
        }

        // Show the last known board immediately, so the screen has content
        // while the network is tried — and something to keep if it fails.
        if case .idle = phase {
            phase = .loading
            if let cache, let cached = await cache.load(BoardResponse.self, for: .board(crs: crs)),
               let board = cached.value.board, !board.departures.isEmpty {
                phase = .loaded(board)
                servedFromCache = cached.storedAt
            }
        }

        do {
            let response = try await api.board(crs: crs)
            guard response.ok, let board = response.board else {
                phase = .empty(reason: response.reason)
                servedFromCache = nil
                return
            }
            guard !board.departures.isEmpty else {
                phase = .empty(reason: "no-departures")
                servedFromCache = nil
                return
            }
            phase = .loaded(board)
            servedFromCache = nil
            if let cache { await cache.store(response, for: .board(crs: crs)) }
        } catch let error as APIError {
            // A failed refresh must not throw away a board the user can still
            // use. Keep it, and let the age be stated rather than implied.
            if case .loaded = phase, servedFromCache != nil { return }
            phase = .failed(error)
        } catch {
            if case .loaded = phase, servedFromCache != nil { return }
            phase = .failed(.transport(error.localizedDescription))
        }
    }
}

struct BoardsView: View {
    @State private var model = BoardModel()
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Departures", lazy: true) {
            Card {
                // Stations only: a departure board for a postcode is
                // meaningless, and offering one produced an enabled button
                // that silently did nothing.
                StationSearchField(
                    label: "Station",
                    selection: $model.station,
                    includePlaces: false
                )
                Button("Show departures") {
                    Task { await model.load(using: env.api, cache: env.cache) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!model.canLoad)
            }
            content
        }
        .refreshable { await model.load(using: env.api, cache: env.cache) }
        .navigationDestination(for: Departure.self) { departure in
            ServiceDetailView(departure: departure)
        }
        // Boards go stale fast; a quiet 30s refresh keeps the times honest
        // without the user pulling.
        //
        // Keyed on the station, and loops. The previous version keyed
        // `.task(id:)` on the board's `generatedAt` and slept once: if the
        // server ever returned the same timestamp twice — a cached board, or a
        // quiet station — the id didn't change, the task never re-fired, and
        // refresh stopped for good while the board still looked live.
        .task(id: refreshKey) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                await model.load(using: env.api, cache: env.cache)
            }
        }
    }

    /// The station being shown. Changing station restarts the refresh loop;
    /// a repeated `generatedAt` no longer stops it.
    private var refreshKey: String {
        if case let .station(crs, _)? = model.station { return crs }
        return "none"
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            EmptyStateCard(
                title: "Pick a station",
                message: "Live departures, platforms and delays.",
                systemImage: "clock"
            )
        case .loading:
            Card {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading board…").foregroundStyle(Palette.inkMuted)
                }
            }
        case let .loaded(board):
            boardHeader(board)
            ForEach(board.departures) { departure in
                NavigationLink(value: departure) {
                    DepartureRow(departure: departure)
                }
                .buttonStyle(.plain)
            }
        case let .empty(reason):
            EmptyStateCard(
                title: reason == "no-departures"
                    ? "No departures"
                    : StatusFormatting.boardFailureTitle(reason: reason),
                message: reason == "no-departures"
                    ? "Nothing is scheduled from here right now."
                    : StatusFormatting.boardFailureMessage(reason: reason),
                systemImage: "clock.badge.questionmark"
            ) {
                Task { await model.load(using: env.api, cache: env.cache) }
            }
        case let .failed(error):
            EmptyStateCard(
                title: "Couldn't load that board",
                message: error.errorDescription ?? "Something went wrong.",
                systemImage: "exclamationmark.triangle",
                retry: error.isRetryable ? { Task { await model.load(using: env.api, cache: env.cache) } } : nil
            )
        }
    }

    private func boardHeader(_ board: Board) -> some View {
        Card {
            HStack {
                Text(board.stationName).font(.title3.weight(.bold))
                Spacer()
                // Says whether these are live times or the timetable — the
                // board must not imply real-time data it hasn't got.
                StatusPill(
                    model.servedFromCache != nil ? "Saved" : (board.live ? "Live" : "Timetable"),
                    tone: model.servedFromCache != nil ? .warn : (board.live ? .good : .neutral)
                )
            }
            // A board served from disk states its age. Showing a stored board
            // as though it were current is the one thing this must not do.
            if let storedAt = model.servedFromCache {
                Text(StatusFormatting.staleBoardNotice(secondsAgo: -storedAt.timeIntervalSinceNow))
                    .font(.caption)
                    .foregroundStyle(Palette.signalAmber)
            }
            if let filter = board.filterName {
                Text("Calling at \(filter)").font(.callout).foregroundStyle(Palette.inkMuted)
            }
            ForEach(board.messages, id: \.self) { message in
                Text(message.strippingHTML)
                    .font(.callout)
                    .foregroundStyle(Palette.signalAmber)
            }
            ForEach(board.disruptions) { disruption in
                if let title = disruption.title {
                    Text(title).font(.callout.weight(.semibold)).foregroundStyle(Palette.signalAmber)
                }
            }
        }
    }
}

private extension String {
    /// NRCC messages arrive as HTML fragments; strip the tags for a plain row.
    var strippingHTML: String {
        replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
