import SwiftUI

/// The commute dashboard: what you're catching, and what's gone wrong with it.
struct CommuteView: View {
    @State private var model = CommuteModel()
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.selectedTab) private var selectedTab

    var body: some View {
        Group {
            if env.auth.isSignedIn {
                dashboard
            } else {
                signedOut
            }
        }
        .navigationDestination(for: Journey.self) { JourneyDetailView(journey: $0) }
        // "Go to work" / "go home" when nothing is scheduled: hand the pair to
        // the planner rather than duplicating a search screen here.
        .navigationDestination(for: JourneyQuery.self) { query in
            PlanView(initialQuery: query)
        }
    }

    private var signedOut: some View {
        AppChrome(title: "Commute") {
            EmptyStateCard(
                title: "Sign in to set up a commute",
                message: "Save your regular journeys and get told when they're disrupted.",
                systemImage: "person.crop.circle"
            )
        }
    }

    private var dashboard: some View {
        AppChrome(title: "Commute") {
            switch model.phase {
            case .loading:
                Card {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading your commute…").foregroundStyle(Palette.inkMuted)
                    }
                }

            case let .loaded(state):
                switch state {
                case let .active(active):
                    activeCard(active)
                    if let notice = active.pinStaleNotice {
                        NoticeCard(title: "Pinned train changed", body: notice.headline)
                    }
                    journeysSection(active)
                    disruptionsSection(active.disruptions)
                    switcher(active.otherCommutes)

                case let .noActive(quiet):
                    Card {
                        Text(quiet.commuteLabel).font(.title3.weight(.bold))
                        Text(quiet.explanation).foregroundStyle(Palette.inkMuted)
                    }
                    if let quick = quiet.quickStart { quickStartCard(quick) }
                    switcher(quiet.otherCommutes)

                case .noCommute:
                    EmptyStateCard(
                        title: "No commute yet",
                        message: "Set one up on the web app to see it here.",
                        systemImage: "calendar.badge.plus"
                    )
                }

            case let .failed(error):
                EmptyStateCard(
                    title: "Couldn't load your commute",
                    message: error.errorDescription ?? "Something went wrong.",
                    systemImage: "exclamationmark.triangle",
                    retry: error.isRetryable ? { Task { await model.load(using: env.api) } } : nil
                )
            }

            alertsSection
        }
        .task {
            await model.load(using: env.api)
            model.startLive(api: env.api, auth: env.auth)
        }
        .refreshable { await model.load(using: env.api) }
        .onDisappear { model.stopLive() }
        // As on the map: a TabView keeps siblings alive, so `onDisappear`
        // alone would leave this stream open after switching tabs.
        .onChange(of: selectedTab) { _, tab in
            if tab == .commute {
                model.startLive(api: env.api, auth: env.auth)
            } else {
                model.stopLive()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.startLive(api: env.api, auth: env.auth)
                Task { await model.load(using: env.api) }
            case .background, .inactive:
                model.stopLive()
            @unknown default:
                break
            }
        }
    }

    // MARK: - Active leg

    private func activeCard(_ active: ActiveDashboard) -> some View {
        Card {
            HStack {
                Text(active.commuteLabel).font(.title3.weight(.bold))
                Spacer()
                StatusPill(active.leg.directionLabel, tone: .neutral)
            }

            HStack(spacing: 8) {
                Text(active.leg.originLabel).font(.body.weight(.semibold))
                Image(systemName: "arrow.right").font(.caption).foregroundStyle(Palette.inkMuted)
                Text(active.leg.destLabel).font(.body.weight(.semibold))
            }

            if let window = windowLabel(active.leg) {
                Text(window).font(.callout).foregroundStyle(Palette.inkMuted)
            }

            // A started run pins the direction so the dashboard can't switch
            // underneath someone who is already on the train.
            if let run = active.run {
                HStack(spacing: 6) {
                    Image(systemName: "figure.walk.motion").font(.caption)
                    Text("Travelling — \(run.originLabel) to \(run.destLabel)")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(Palette.signalGreen)

                Button("I've arrived") {
                    Task { await model.endRun(commuteId: active.commuteId, using: env.api) }
                }
                .buttonStyle(SecondaryButtonStyle())
            } else {
                Button("Start commute") {
                    Task { await model.startRun(active, using: env.api) }
                }
                .buttonStyle(PrimaryButtonStyle())
            }

            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRed)
            }
        }
    }

    private func windowLabel(_ leg: ActiveLeg) -> String? {
        guard let start = leg.windowStart, let end = leg.windowEnd else { return nil }
        return leg.upcoming ? "Leaving between \(start) and \(end)" : "Window \(start)–\(end)"
    }

    @ViewBuilder
    private func journeysSection(_ active: ActiveDashboard) -> some View {
        if active.engineOffline {
            // Say why the list is empty rather than showing a bare "no trains".
            EmptyStateCard(
                title: "Routing is offline",
                message: "Can't work out your trains right now. Live alerts still apply.",
                systemImage: "exclamationmark.triangle"
            ) {
                Task { await model.load(using: env.api) }
            }
        } else if active.journeys.isEmpty {
            EmptyStateCard(
                title: "No trains found",
                message: "Nothing runs in this window right now.",
                systemImage: "tram"
            )
        } else {
            ForEach(active.journeys) { journey in
                NavigationLink(value: journey) { JourneyRow(journey: journey) }
                    .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func disruptionsSection(_ disruptions: [Disruption]) -> some View {
        if !disruptions.isEmpty {
            Card {
                LabelText("At your station")
                ForEach(disruptions) { disruption in
                    if let title = disruption.title {
                        Text(title).font(.callout.weight(.semibold))
                            .foregroundStyle(Palette.signalAmber)
                    }
                    if let summary = disruption.summary {
                        Text(summary).font(.caption).foregroundStyle(Palette.inkMuted)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func switcher(_ others: [OtherCommute]) -> some View {
        if !others.isEmpty {
            Card {
                LabelText("Other commutes")
                ForEach(others) { other in
                    Button(other.label) {
                        Task { await model.select(commuteId: other.id, api: env.api) }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
            }
        }
    }

    private func quickStartCard(_ quick: QuickStart) -> some View {
        Card {
            LabelText("Plan anyway")
            Text("Nothing scheduled, but you can still check.")
                .font(.callout).foregroundStyle(Palette.inkMuted)
            HStack(spacing: 10) {
                NavigationLink(value: JourneyQuery(from: quick.homeCrs, to: quick.workCrs)) {
                    Text("To \(quick.workLabel)").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())

                NavigationLink(value: JourneyQuery(from: quick.workCrs, to: quick.homeCrs)) {
                    Text("To \(quick.homeLabel)").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    // MARK: - Alerts

    @ViewBuilder
    private var alertsSection: some View {
        if !model.alerts.isEmpty {
            Card {
                HStack {
                    LabelText("Alerts")
                    Spacer()
                    if model.unseenCount > 0 {
                        Button("Mark all seen") {
                            Task { await model.markAlertsSeen(using: env.api) }
                        }
                        .font(.caption.weight(.semibold))
                    }
                }
                ForEach(model.alerts.prefix(10)) { alert in
                    AlertRow(alert: alert)
                }
                if model.alerts.count > 10 {
                    NavigationLink("See all \(model.alerts.count) alerts") { AlertsView() }
                        .font(.caption.weight(.semibold))
                }
            }
        }
    }
}

/// A from→to pair to plan, carried by a NavigationLink.
struct JourneyQuery: Hashable {
    let from: String
    let to: String
}
