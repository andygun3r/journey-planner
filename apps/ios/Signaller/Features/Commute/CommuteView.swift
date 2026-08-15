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
    }

    /// Signed out, this tab was a single card of text with nothing to tap —
    /// the user had to work out for themselves that Account is where you sign
    /// in. Now it says so and takes them there.
    private var signedOut: some View {
        AppChrome(title: "Commute") {
            Card {
                Text("Sign in to set up a commute")
                    .font(.title3.weight(.bold))
                Text("Save your regular journeys and get told when they're disrupted.")
                    .foregroundStyle(Palette.inkMuted)
                Button("Sign in") { selectTab(.account) }
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    private var dashboard: some View {
        AppChrome(title: "Commute") {
            // Shown when the dashboard came from disk because the network
            // didn't answer — the legs are probably still right, but the
            // times and disruptions may not be, and that has to be said.
            if let storedAt = model.servedFromCache {
                HStack(spacing: 6) {
                    Image(systemName: "wifi.slash")
                        .font(.caption)
                        .accessibilityHidden(true)
                    Text(StatusFormatting.lastUpdated(secondsAgo: -storedAt.timeIntervalSinceNow))
                        .font(.caption)
                }
                .foregroundStyle(Palette.signalAmber)
            }

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
                    planningCard(commuteId: active.commuteId, label: active.commuteLabel)
                    switcher(active.otherCommutes)

                case let .noActive(quiet):
                    Card {
                        Text(quiet.commuteLabel).font(.title3.weight(.bold))
                        Text(quiet.explanation).foregroundStyle(Palette.inkMuted)
                    }
                    if let quick = quiet.quickStart { quickStartCard(quick) }
                    planningCard(commuteId: quiet.commuteId, label: quiet.commuteLabel)
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
                    retry: error.isRetryable ? { Task { await model.load(using: env.api, cache: env.cache) } } : nil
                )
            }

            alertsSection
        }
        .task {
            await model.load(using: env.api, cache: env.cache)
            model.startLive(api: env.api, auth: env.auth)
        }
        .refreshable { await model.load(using: env.api, cache: env.cache) }
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
                Task { await model.load(using: env.api, cache: env.cache) }
            case .background, .inactive:
                model.stopLive()
            @unknown default:
                break
            }
        }
    }

    /// Day-to-day commute changes: which days you're not travelling, and when
    /// you're away. Both were web-only, and both are decided on a phone.
    private func planningCard(commuteId: String, label: String) -> some View {
        Card {
            NavigationLink {
                CommuteCalendarView(commuteId: commuteId, commuteLabel: label)
            } label: {
                planningRow("Calendar", detail: "Days you're not commuting", systemImage: "calendar")
            }
            .buttonStyle(.plain)

            Divider()

            NavigationLink {
                HolidaysView()
            } label: {
                planningRow("Holidays", detail: "Pause alerts while you're away", systemImage: "sun.max")
            }
            .buttonStyle(.plain)
        }
    }

    private func planningRow(_ title: String, detail: String, systemImage: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(Palette.railNavy)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(Palette.inkMuted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.inkMuted)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }

    // MARK: - Active leg

    /// The commute you're on, or about to start.
    ///
    /// A `HeroCard` rather than a `Card`: this is the one thing the tab exists
    /// to answer, and it previously carried the same weight as the "Holidays"
    /// navigation row below it. DESIGN.md's rule — "let the personal (commute)
    /// always outweigh the ambient (network) on a dashboard".
    private func activeCard(_ active: ActiveDashboard) -> some View {
        HeroCard {
            HStack {
                Text(active.commuteLabel).font(.title3.weight(.bold))
                Spacer()
                StatusPill(active.leg.directionLabel, tone: .neutral)
            }

            HStack(spacing: 8) {
                Text(active.leg.originLabel).font(.body.weight(.semibold))
                Image(systemName: "arrow.right")
                    .font(.caption)
                    .foregroundStyle(Palette.onNavy.opacity(0.75))
                    .accessibilityHidden(true)
                Text(active.leg.destLabel).font(.body.weight(.semibold))
            }

            if let window = windowLabel(active.leg) {
                Text(window).font(.callout).foregroundStyle(Palette.onNavy.opacity(0.85))
            }

            // A started run pins the direction so the dashboard can't switch
            // underneath someone who is already on the train.
            if let run = active.run {
                // Signal Green is 3.03:1 on Rail Navy — it fails here, and the
                // "Travelling" state is carried by the words and the symbol
                // anyway, so on navy it goes white rather than a colour that
                // can't be read.
                HStack(spacing: 6) {
                    Image(systemName: "figure.walk.motion")
                        .font(.caption)
                        .accessibilityHidden(true)
                    Text("Travelling — \(run.originLabel) to \(run.destLabel)")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(Palette.onNavy)

                Button("I've arrived") {
                    Task { await model.endRun(commuteId: active.commuteId, using: env.api) }
                }
                .buttonStyle(OnNavyButtonStyle())
            } else {
                // A navy button on a navy card is 1.00:1 — invisible. The
                // action inverts to white on navy instead.
                Button("Start commute") {
                    Task { await model.startRun(active, using: env.api) }
                }
                .buttonStyle(OnNavyButtonStyle())
            }

            if let error = model.actionError {
                Text(error)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.onNavy)
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
                Task { await model.load(using: env.api, cache: env.cache) }
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

    /// Hands a from→to pair to the planner in the Trains tab.
    ///
    /// This used to push a whole `PlanView` inside the Commute tab, so the app
    /// ran two planners with separate state. Now there is one.
    private func plan(from: String, to: String) {
        env.pendingJourney = JourneyQuery(from: from, to: to)
        selectTab(.trains)
    }

    private func selectTab(_ tab: RootView.Tab) {
        env.requestedTab = tab
    }

    private func quickStartCard(_ quick: QuickStart) -> some View {
        Card {
            LabelText("Plan anyway")
            Text("Nothing scheduled, but you can still check.")
                .font(.callout).foregroundStyle(Palette.inkMuted)
            HStack(spacing: 10) {
                Button {
                    plan(from: quick.homeCrs, to: quick.workCrs)
                } label: {
                    Text("To \(quick.workLabel)").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())

                Button {
                    plan(from: quick.workCrs, to: quick.homeCrs)
                } label: {
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
                ForEach(model.alerts.prefix(5)) { alert in
                    AlertRow(alert: alert)
                    if alert.id != model.alerts.prefix(5).last?.id { RowDivider() }
                }
                // Unconditional. This was gated on `count > 10`, so with ten
                // or fewer alerts there was no route to the alerts screen
                // anywhere in the app — and no other entry point exists.
                NavigationLink { AlertsView() } label: {
                    NavRow(
                        title: model.alerts.count > 5
                            ? "See all \(model.alerts.count) alerts"
                            : "Alert history"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A from→to pair to plan, carried by a NavigationLink.
struct JourneyQuery: Hashable {
    let from: String
    let to: String
}
