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

    func load(using api: APIClient) async {
        guard case let .station(crs, _)? = station else { return }
        if case .idle = phase { phase = .loading }
        do {
            let response = try await api.board(crs: crs)
            guard response.ok, let board = response.board else {
                phase = .empty(reason: response.reason)
                return
            }
            guard !board.departures.isEmpty else {
                phase = .empty(reason: "no-departures")
                return
            }
            phase = .loaded(board)
        } catch let error as APIError {
            phase = .failed(error)
        } catch {
            phase = .failed(.transport(error.localizedDescription))
        }
    }
}

struct BoardsView: View {
    @State private var model = BoardModel()
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Departures") {
            Card {
                StationSearchField(label: "Station", selection: $model.station)
                Button("Show departures") {
                    Task { await model.load(using: env.api) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(model.station == nil)
            }
            content
        }
        .refreshable { await model.load(using: env.api) }
        .navigationDestination(for: Departure.self) { departure in
            ServiceDetailView(departure: departure)
        }
        // Boards go stale fast; a quiet 30s refresh keeps the times honest
        // without the user pulling.
        .task(id: refreshTicker) {
            guard case .loaded = model.phase else { return }
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await model.load(using: env.api)
        }
    }

    /// Changes whenever a load completes, restarting the refresh timer.
    private var refreshTicker: String {
        if case let .loaded(board) = model.phase { return board.generatedAt.description }
        return "idle"
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
                Task { await model.load(using: env.api) }
            }
        case let .failed(error):
            EmptyStateCard(
                title: "Couldn't load that board",
                message: error.errorDescription ?? "Something went wrong.",
                systemImage: "exclamationmark.triangle",
                retry: error.isRetryable ? { Task { await model.load(using: env.api) } } : nil
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
                StatusPill(board.live ? "Live" : "Timetable", tone: board.live ? .good : .neutral)
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
