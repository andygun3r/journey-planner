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

        var isIdle: Bool {
            if case .idle = self { return true }
            return false
        }
    }

    var station: JourneyEndpoint?
    private(set) var phase: Phase = .idle

    /// When the board on screen was stored, if it came from the cache.
    ///
    /// Non-nil means "this is what we had last time, not what's true now" —
    /// and the UI must say so out loud.
    private(set) var servedFromCache: Date?

    /// Which station the board currently on screen belongs to.
    ///
    /// Needed to tell a refresh of the same station (keep showing it) from a
    /// switch to a new one (never show the old station's trains under the new
    /// station's name).
    private(set) var loadedCRS: String?

    /// Only a station can have a departure board. Gates the button so a
    /// non-station selection can't produce a tap that does nothing.
    var canLoad: Bool {
        if case .station? = station { return true }
        return false
    }

    /// Puts the last stored board for this station on screen, if there is one.
    /// Leaves `.loading` showing when there isn't.
    private func showCached(crs: String, using cache: ResponseCache?) async {
        phase = .loading
        servedFromCache = nil
        guard let cache,
              let cached = await cache.load(BoardResponse.self, for: .board(crs: crs)),
              let board = cached.value.board,
              !board.departures.isEmpty
        else { return }
        phase = .loaded(board)
        servedFromCache = cached.storedAt
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
        //
        // Also runs when the station changed, not only from idle: otherwise
        // asking for a second station left the *first* station's departures on
        // screen under the new station's name until the network answered.
        if phase.isIdle || crs != loadedCRS {
            await showCached(crs: crs, using: cache)
        }

        loadedCRS = crs

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Which row is open, if any. View state, not model state: a refresh that
    /// replaces the board must not carry a stale expansion with it, and this
    /// dies with the screen rather than surviving in `BoardModel`.
    @State private var expanded: Departure.ID?

    /// Whether the full search card is showing. Collapses to a one-line station
    /// chip once a board loads — the search occupied 123pt of a 686pt screen
    /// permanently, on the one surface that exists to show a list.
    @State private var searching = true

    /// Station messages and disruptions, folded away unless asked for. They
    /// matter when they exist, but they were pushing departures off the fold
    /// on every board that had a routine notice.
    @State private var showingNotices = false

    /// A service pushed by a deep link rather than by tapping a row.
    @State private var pushedService: Departure?

    var body: some View {
        // No title: `TrainsView` owns the navigation bar for this tab.
        AppChrome(title: nil, lazy: true) {
            searchSection
            content
        }
        .refreshable { await model.load(using: env.api, cache: env.cache) }
        .navigationDestination(for: Departure.self) { departure in
            ServiceDetailView(departure: departure)
        }
        // A deep link or notification tap naming a station opens that board.
        //
        // Deliberately `onChange` + `Task`, not `.task(id: pendingBoardCRS)`:
        // consuming the link clears the CRS, which would change that id and
        // cancel the very load it started (URLError -999, an empty board).
        .onChange(of: env.pendingBoardCRS, initial: true) { _, crs in
            guard crs != nil else { return }
            Task { await openPendingBoard() }
        }
        .onChange(of: env.pendingServiceID) { _, id in
            guard let id else { return }
            // Only the rid is known; the service screen fetches the rest.
            pushedService = Departure.placeholder(rid: id, destination: "Service")
            env.pendingServiceID = nil
        }
        .navigationDestination(item: $pushedService) { departure in
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

    /// Opens the board a deep link asked for.
    ///
    /// The name comes from the bundled station index, so a notification tap
    /// shows "London Waterloo" rather than "WAT" — and still works with no
    /// signal, since the index is on disk.
    private func openPendingBoard() async {
        guard let crs = env.pendingBoardCRS else { return }
        env.pendingBoardCRS = nil

        let name = env.stations.stations.first { $0.crs == crs }?.name ?? crs
        model.station = .station(crs: crs, name: name)
        searching = false
        expanded = nil
        await model.load(using: env.api, cache: env.cache)
    }

    // MARK: - Search

    /// Full card while choosing; a single row once a board is on screen.
    @ViewBuilder
    private var searchSection: some View {
        if searching {
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
                    searching = false
                    Task { await model.load(using: env.api, cache: env.cache) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!model.canLoad)
            }
        } else if case let .loaded(board) = model.phase {
            stationChip(board)
        }
    }

    /// The collapsed search: which station, whether it's live, and a way back.
    private func stationChip(_ board: Board) -> some View {
        Button {
            searching = true
        } label: {
            HStack(spacing: 8) {
                Text(board.stationName)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.inkMuted)
                    .accessibilityHidden(true)
                Spacer(minLength: 4)
                StatusPill(
                    model.servedFromCache != nil ? "Saved" : (board.live ? "Live" : "Timetable"),
                    tone: model.servedFromCache != nil ? .warn : (board.live ? .good : .neutral)
                )
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(board.stationName), change station")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle:
            // The tab bar was the app's entire onboarding — nothing anywhere
            // said what Signaller is before you signed in. Lead with the
            // answer, per the brand voice: no hedging, no welcome copy.
            EmptyStateCard(
                title: "Pick a station",
                message: "Live departures, real platforms and where each train actually is.",
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
            staleNotice
            noticesSection(board)

            // The next train, answered without reading the list.
            if let next = board.departures.first {
                NextDepartureHero(departure: next) { toggle(next.id) }
            }

            departureList(board)
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

    /// The departures themselves, as lines rather than cards.
    ///
    /// One `Card` wraps the whole list instead of one per row: the rows are
    /// separated by hairlines, which is what lets eight trains fit where three
    /// did. The first departure is already in the hero above, so it is not
    /// repeated here.
    private func departureList(_ board: Board) -> some View {
        let rest = Array(board.departures.dropFirst())
        // Zero padding: `DepartureLine` carries its own 16pt insets so the
        // hairlines run the full width of the card rather than stopping short.
        return Card(spacing: 0, padding: 0) {
            if rest.isEmpty {
                Text("Nothing else scheduled from here right now.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
                    .padding(16)
            } else {
                ForEach(rest) { departure in
                    DepartureLine(
                        departure: departure,
                        isExpanded: expanded == departure.id
                    ) {
                        toggle(departure.id)
                    }
                    if departure.id != rest.last?.id { RowDivider() }
                }
            }
        }
    }

    /// One row open at a time — a second tap on another row closes the first.
    private func toggle(_ id: Departure.ID) {
        // Live boards reorder themselves as trains are retimed; animating that
        // is exactly what `accessibilityReduceMotion` exists to prevent.
        if reduceMotion {
            expanded = expanded == id ? nil : id
        } else {
            withAnimation(.easeOut(duration: 0.18)) {
                expanded = expanded == id ? nil : id
            }
        }
    }

    /// A board served from disk states its age. Showing a stored board as
    /// though it were current is the one thing this must not do.
    @ViewBuilder
    private var staleNotice: some View {
        if let storedAt = model.servedFromCache {
            HStack(spacing: 6) {
                Image(systemName: "wifi.slash")
                    .font(.caption)
                    .accessibilityHidden(true)
                Text(StatusFormatting.staleBoardNotice(secondsAgo: -storedAt.timeIntervalSinceNow))
                    .font(.caption)
            }
            .foregroundStyle(Palette.signalAmber)
        }
    }

    /// Station messages, disruptions and any "calling at" filter.
    ///
    /// Collapsed by default and counted in the summary, so a board with three
    /// routine NRCC notices doesn't push every departure below the fold — but
    /// the notices are never hidden outright, only folded.
    @ViewBuilder
    private func noticesSection(_ board: Board) -> some View {
        let messages = board.messages.map(\.strippingHTML).filter { !$0.isEmpty }
        let count = messages.count + board.disruptions.count

        if count > 0 || board.filterName != nil {
            Card {
                if let filter = board.filterName {
                    Text("Calling at \(filter)")
                        .font(.callout)
                        .foregroundStyle(Palette.inkMuted)
                }

                if count > 0 {
                    Button {
                        showingNotices.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.caption)
                                .accessibilityHidden(true)
                            Text(count == 1 ? "1 notice at this station" : "\(count) notices at this station")
                                .font(.callout.weight(.semibold))
                            Spacer(minLength: 0)
                            Image(systemName: showingNotices ? "chevron.up" : "chevron.down")
                                .font(.caption.weight(.semibold))
                                .accessibilityHidden(true)
                        }
                        .foregroundStyle(Palette.signalAmber)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(showingNotices ? "Collapse" : "Expand")

                    if showingNotices {
                        ForEach(messages, id: \.self) { message in
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(Palette.inkMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(board.disruptions) { disruption in
                            VStack(alignment: .leading, spacing: 2) {
                                if let title = disruption.title {
                                    Text(title)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(Palette.signalAmber)
                                }
                                if let summary = disruption.summary {
                                    Text(summary)
                                        .font(.caption)
                                        .foregroundStyle(Palette.inkMuted)
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true)
                        }
                    }
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
