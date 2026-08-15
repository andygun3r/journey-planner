import SwiftUI
import Observation

@Observable
@MainActor
final class ServiceModel {
    enum Phase {
        case loading
        case loaded(ServiceDetail)
        /// The board row carries neither a rid nor a trip id, so there is
        /// nothing to look up. Distinct from `.failed`: nothing went wrong,
        /// this train simply isn't trackable yet.
        case untrackable
        case failed(APIError)
    }

    private(set) var phase: Phase = .loading

    /// The most recent live position, pushed by the SSE stream.
    private(set) var livePosition: LivePosition?
    private(set) var live: LiveChannel?

    /// Opens the live stream for a resolved train. Only a rid can be tracked —
    /// a timetable trip has nothing to correlate against.
    func startLive(rid: String, api: APIClient, auth: AuthStore) {
        guard live == nil else { return }
        let channel = LiveChannel(
            path: "/api/live/service",
            query: [URLQueryItem(name: "rid", value: rid)],
            api: api,
            auth: auth
        ) { [weak self] event in
            guard event.name == "position" else { return }
            // `data: null` is the documented "not correlated" case, not an
            // error — clear the position rather than holding a stale one.
            guard let data = event.data.data(using: .utf8) else { return }
            self?.livePosition = try? JSONDecoder.signaller.decode(LivePosition.self, from: data)
        }
        live = channel
        channel.start()
    }

    func stopLive() {
        live?.stop()
        live = nil
    }

    /// No rid and no trip id — there is nothing to fetch.
    func markUntrackable() {
        phase = .untrackable
    }

    func load(serviceId: String, using api: APIClient) async {
        do {
            let response = try await api.service(id: serviceId)
            guard response.ok, let service = response.service else {
                phase = .failed(.http(status: 404, reason: response.reason))
                return
            }
            phase = .loaded(service)
        } catch let error as APIError {
            phase = .failed(error)
        } catch {
            phase = .failed(.transport(error.localizedDescription))
        }
    }
}

/// The calling pattern for one train, with live progress.
///
/// Reached by tapping a board row. There was no equivalent screen before — the
/// board was a dead end.
struct ServiceDetailView: View {
    let departure: Departure

    @State private var model = ServiceModel()
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        AppChrome(title: departure.destinationName) {
            content
        }
        .task { await load() }
        .refreshable { await load() }
        .onDisappear { model.stopLive() }
        // Stand the stream down in the background — a socket held open behind
        // the lock screen drains battery for updates nobody can see — and pick
        // it back up on return.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: startLiveIfPossible()
            case .background, .inactive: model.stopLive()
            @unknown default: break
            }
        }
        // Keep the Live Activity in step with the stream. This is what makes
        // activities app-driven: no push token, no server round-trip.
        .onChange(of: model.livePosition) { _, position in
            guard let position, env.liveActivities.hasActiveActivity else { return }
            Task {
                await env.liveActivities.update(
                    status: position.statusText,
                    currentStop: position.lastStopName ?? position.label ?? departure.originName ?? "",
                    nextStop: position.nextStopName,
                    eta: position.estimatedArrival ?? departure.effectiveTime,
                    delayMinutes: position.latenessMinutes.map { Int($0.rounded()) }
                )
            }
        }
    }

    private func startLiveIfPossible() {
        guard let rid = departure.rid else { return }
        model.startLive(rid: rid, api: env.api, auth: env.auth)
    }

    private func load() async {
        // A rid is the better identifier when the live overlay has matched the
        // trip; tripId is the timetable fallback. A row can legitimately have
        // neither — `Departure.id` falls back to scheduled time + destination
        // precisely for that case — and returning here used to leave `phase`
        // at `.loading`, so the user watched a spinner that could never resolve.
        guard let id = departure.rid.map({ "rid:\($0)" }) ?? departure.tripId else {
            model.markUntrackable()
            return
        }
        await model.load(serviceId: id, using: env.api)
        startLiveIfPossible()
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            Card {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading service…").foregroundStyle(Palette.inkMuted)
                }
            }
        case let .loaded(service):
            headerCard(service)
            progressCard(service.progress)
            callsCard(service)
            if !service.coaches.isEmpty { formationCard(service) }
        case .untrackable:
            // Say what's actually true rather than showing a failure: the
            // board knows this train runs, it just has no id to follow it by.
            EmptyStateCard(
                title: "No details for this train yet",
                message: """
                    It's on the board, but the live feed hasn't matched it to a \
                    service yet — so there's no calling pattern to show. Check \
                    the board again closer to departure.
                    """,
                systemImage: "clock.badge.questionmark"
            )
        case let .failed(error):
            EmptyStateCard(
                title: "Service details unavailable",
                message: error.errorDescription ?? "Couldn't load this train.",
                systemImage: "exclamationmark.triangle",
                retry: error.isRetryable ? { Task { await load() } } : nil
            )
        }
    }

    private func headerCard(_ service: ServiceDetail) -> some View {
        Card {
            HStack {
                Text(service.stationName).font(.title3.weight(.bold))
                Spacer()
                if let platform = service.platform {
                    Text("Plat \(platform)").font(.callout.weight(.semibold))
                }
            }
            if let operatorName = service.operatorName {
                Text(operatorName).font(.callout).foregroundStyle(Palette.inkMuted)
            }
            if service.cancelled {
                StatusPill("Cancelled", tone: .bad)
                if let reason = service.cancelReason {
                    Text(reason).font(.caption).foregroundStyle(Palette.signalRed)
                }
            } else if let reason = service.delayReason {
                Text(reason).font(.caption).foregroundStyle(Palette.signalAmber)
            }
        }
    }

    /// Live tracking state, worded so "not tracked" never reads as "broken".
    private func progressCard(_ progress: ServiceProgress) -> some View {
        Card {
            HStack {
                LabelText("Live tracking")
                Spacer()
                if model.live?.state == .live {
                    // Says the data is streaming, not polled — the difference
                    // between "this is current" and "this was current".
                    HStack(spacing: 4) {
                        Circle().fill(Palette.signalGreen).frame(width: 6, height: 6)
                        Text("Live").font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(Palette.signalGreen)
                }
            }

            // Streamed position wins over the snapshot fetched on load.
            if let position = model.livePosition {
                if let label = position.label {
                    Text(label).font(.body.weight(.medium))
                }
                if let next = position.nextStopName {
                    Text("Next stop \(next)").font(.callout).foregroundStyle(Palette.inkMuted)
                }
                HStack(spacing: 6) {
                    Text(position.statusText).font(.caption.weight(.semibold))
                    if position.stale == true, let ago = position.reportedAgoSeconds {
                        Text("· \(StatusFormatting.reportedAgo(seconds: ago))").font(.caption2)
                    }
                }
                .foregroundStyle(position.stale == true ? Palette.inkMuted : Palette.signalGreen)
            }

            switch progress.positionState {
            case .tracked:
                if let last = progress.lastStopName {
                    Text("Last seen at \(last)").font(.body.weight(.medium))
                }
                if let next = progress.nextStopName {
                    Text("Next stop \(next)").font(.callout).foregroundStyle(Palette.inkMuted)
                }
                if let location = progress.nrLastLocation {
                    HStack(spacing: 4) {
                        Image(systemName: "location.fill").font(.caption2)
                        Text(location).font(.caption)
                        if let ago = progress.nrReportedAgoSeconds {
                            Text("· \(StatusFormatting.reportedAgo(seconds: ago))").font(.caption2)
                        }
                    }
                    .foregroundStyle(Palette.signalGreen)
                }
            case .awaitingReport:
                // The important distinction: running, but nothing reported yet.
                Text("Running — no position reported yet")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            case .notTracked:
                Text("This train isn't being tracked live.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            }

            if progress.arrived {
                StatusPill("Arrived", tone: .good)
            }
        }
    }

    private func callsCard(_ service: ServiceDetail) -> some View {
        Card {
            LabelText("Calling at")
            ForEach(service.calls) { call in
                CallRow(call: call)
            }
        }
    }

    private func formationCard(_ service: ServiceDetail) -> some View {
        Card {
            LabelText("Formation")
            if let length = service.length {
                Text("\(length) coaches").font(.callout).foregroundStyle(Palette.inkMuted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(service.coaches) { coach in
                        VStack(spacing: 2) {
                            Text(coach.number).font(.caption.weight(.bold))
                            if coach.first {
                                Text("1st").font(.caption2).foregroundStyle(Palette.inkMuted)
                            }
                            if let loading = coach.loading {
                                Text("\(loading)%").font(.caption2).foregroundStyle(loadingTone(loading))
                            }
                        }
                        .frame(width: 46, height: 54)
                        .background(Palette.railNavyTint)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }

    private func loadingTone(_ loading: Int) -> Color {
        switch loading {
        case ..<50: return Palette.signalGreen
        case ..<80: return Palette.signalAmber
        default: return Palette.signalRed
        }
    }
}

private struct CallRow: View {
    let call: ServiceCall

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // Progress dot: filled for stops already passed.
            Image(systemName: symbolName)
                .font(.caption)
                .foregroundStyle(symbolColor)
                .frame(width: 14)

            Text(call.name)
                .font(.body.weight(call.progress == .current ? .bold : .regular))
                .strikethrough(call.cancelled)
                .foregroundStyle(call.cancelled ? Palette.signalRed : Palette.ink)
                .lineLimit(1)

            Spacer(minLength: 0)

            if let platform = call.platform {
                Text("Plat \(platform)").font(.caption).foregroundStyle(Palette.inkMuted)
            }

            // `expected` is display text, not always a time — it may read
            // "On time" or "Delayed". Show it verbatim.
            Text(call.actual ?? call.expected ?? call.scheduled ?? "--:--")
                .font(.callout.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(timeColor)
        }
        .padding(.vertical, 3)
        .opacity(call.progress == .departed ? 0.55 : 1)
        // Progress through the journey was carried entirely by the icon and
        // its colour, so VoiceOver got a station and a time but no sense of
        // where the train actually is.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            AccessibleLabels.call(
                stationName: call.name,
                time: call.actual ?? call.expected ?? call.scheduled ?? "no time",
                state: accessibleState,
                platform: call.platform
            )
        )
    }

    private var accessibleState: AccessibleLabels.CallState {
        if call.cancelled { return .cancelled }
        switch call.progress {
        case .departed: return .departed
        case .current: return .current
        default: return .upcoming
        }
    }

    private var symbolName: String {
        switch call.progress {
        case .departed: return "checkmark.circle.fill"
        case .current: return "location.circle.fill"
        default: return "circle"
        }
    }

    private var symbolColor: Color {
        switch call.progress {
        case .departed: return Palette.signalGreen
        case .current: return Palette.railNavy
        default: return Palette.inkMuted
        }
    }

    private var timeColor: Color {
        if call.cancelled { return Palette.signalRed }
        if call.actual != nil { return Palette.signalGreen }
        return Palette.ink
    }
}
