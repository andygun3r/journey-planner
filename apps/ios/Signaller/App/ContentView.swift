import SwiftUI

private enum Palette {
    static let railNavy = Color(red: 0.11, green: 0.14, blue: 0.25)
    static let railNavyTint = Color(red: 0.91, green: 0.91, blue: 0.94)
    static let signalRed = Color(red: 0.84, green: 0.21, blue: 0.17)
    static let signalAmber = Color(red: 0.63, green: 0.33, blue: 0.0)
    static let signalGreen = Color(red: 0.18, green: 0.49, blue: 0.27)
    static let platformWhite = Color(red: 0.96, green: 0.96, blue: 0.94)
    static let inkMuted = Color(red: 0.29, green: 0.31, blue: 0.36)
}

struct ContentView: View {
    var body: some View {
        TabView {
            PlanView()
                .tabItem { Label("Plan", systemImage: "tram") }
            BoardsView()
                .tabItem { Label("Boards", systemImage: "clock") }
            StatusView()
                .tabItem { Label("Status", systemImage: "waveform.path.ecg") }
        }
        .tint(Palette.railNavy)
    }
}

struct AppChrome<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content
                }
                .padding(16)
            }
            .background(Palette.platformWhite)
            .navigationTitle("Signaller")
            .toolbarBackground(Palette.railNavy, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }
}

struct PlanView: View {
    @State private var from = "WAT"
    @State private var to = "VIC"
    @State private var response: JourneyResponse?
    @State private var error: String?
    @State private var loading = false
    @StateObject private var liveActivities = LiveActivityController()

    var body: some View {
        AppChrome {
            Card {
                LabelText("Journey planner")
                Text("Plan a journey")
                    .font(.largeTitle.weight(.bold))
                Text("Use CRS station codes for the first native slice.")
                    .foregroundStyle(Palette.inkMuted)

                HStack(spacing: 12) {
                    StationField(label: "From", value: $from)
                    StationField(label: "To", value: $to)
                }

                Button(loading ? "Planning..." : "Find trains") {
                    Task { await submit() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(loading)
            }

            if let error {
                NoticeCard(title: "Backend unavailable", body: error)
            }

            if let response, !response.ok {
                NoticeCard(title: failureTitle(response.reason), body: "The backend could not return journeys for that request.")
            }

            if let message = liveActivities.message {
                NoticeCard(title: "Live Activity", body: message)
            }

            ForEach(response?.journeys ?? []) { journey in
                JourneyCard(journey: journey, liveActivities: liveActivities)
            }
        }
    }

    private func submit() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            response = try await APIClient.shared.plan(from: from, to: to)
        } catch {
            response = nil
            self.error = "Could not reach \(APIClient.shared.baseURL.absoluteString)."
        }
    }
}

struct BoardsView: View {
    @State private var crs = "WAT"
    @State private var response: BoardResponse?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        AppChrome {
            Card {
                Text("Departure board")
                    .font(.largeTitle.weight(.bold))
                Text("Live boards by CRS station code.")
                    .foregroundStyle(Palette.inkMuted)
                HStack(spacing: 12) {
                    StationField(label: "Station", value: $crs)
                    Button(loading ? "Loading..." : "Load") {
                        Task { await submit() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(loading)
                }
            }

            if let error {
                NoticeCard(title: "Backend unavailable", body: error)
            }

            if let response, !response.ok {
                NoticeCard(title: boardFailureTitle(response.reason), body: "Signaller could not return a board for that station.")
            }

            if let board = response?.board {
                HStack {
                    Text(board.stationName)
                        .font(.title2.weight(.bold))
                    Spacer()
                    StatusPill(board.live ? "Live" : board.source, tone: board.live ? .good : .neutral)
                }
                ForEach(board.departures) { departure in
                    DepartureCard(departure: departure)
                }
            }
        }
    }

    private func submit() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            response = try await APIClient.shared.board(crs: crs)
        } catch {
            response = nil
            self.error = "Could not reach \(APIClient.shared.baseURL.absoluteString)."
        }
    }
}

struct StatusView: View {
    @State private var health: HealthResponse?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        AppChrome {
            Card {
                Text("Backend status")
                    .font(.largeTitle.weight(.bold))
                Text(APIClient.shared.baseURL.absoluteString)
                    .foregroundStyle(Palette.inkMuted)
                Button(loading ? "Checking..." : "Refresh") {
                    Task { await refresh() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(loading)
            }

            if let error {
                NoticeCard(title: "No connection", body: error)
            }

            if let health {
                Card {
                    HStack {
                        Text(health.service)
                            .font(.title2.weight(.bold))
                        Spacer()
                        StatusPill(health.ok ? "Serving" : "Degraded", tone: health.ok ? .good : .bad)
                    }
                    StatusRow(label: "Postgres", ok: health.postgres)
                    StatusRow(label: "Redis", ok: health.redis)
                    StatusRow(label: "Schema", ok: health.schema)
                }
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            health = try await APIClient.shared.health()
        } catch {
            health = nil
            self.error = "Could not reach the configured backend."
        }
    }
}

struct JourneyCard: View {
    let journey: Journey
    @ObservedObject var liveActivities: LiveActivityController

    var body: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(timeLabel(journey.liveDeparts ?? journey.departs))
                        .font(.system(size: 42, weight: .bold, design: .rounded))
                    Text("Arrives \(timeLabel(journey.liveArrives ?? journey.arrives))")
                        .foregroundStyle(Palette.inkMuted)
                }
                Spacer()
                StatusPill(statusLabel(journey), tone: tone)
            }

            Divider()

            Text("\(journey.legs.first?.originName ?? "Origin") to \(journey.legs.last?.destName ?? "destination")")
                .font(.title3.weight(.bold))
            Text("\(journey.durationMinutes) min · \(journey.changes) change\(journey.changes == 1 ? "" : "s")")
                .foregroundStyle(Palette.inkMuted)

            ForEach(journey.legs.prefix(3)) { leg in
                Text("\(timeLabel(leg.departs)) \(leg.originName) to \(leg.destName)")
                    .font(.callout.weight(.medium))
            }

            Button("Start Live Activity") {
                liveActivities.startPreview(for: journey)
            }
            .buttonStyle(SecondaryButtonStyle())
        }
    }

    private var tone: PillTone {
        if journey.status == "cancelled" { return .bad }
        if journey.status == "delayed" { return .warn }
        return .good
    }
}

struct DepartureCard: View {
    let departure: Departure

    var body: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(timeLabel(departure.live ?? departure.scheduled))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                    Text(departure.destinationName)
                        .font(.title3.weight(.bold))
                    Text(departure.operatorName ?? "Operator unavailable")
                        .foregroundStyle(Palette.inkMuted)
                }
                Spacer()
                VStack {
                    Text("Plat")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Palette.inkMuted)
                    Text(departure.platform ?? "-")
                        .font(.title2.weight(.bold))
                }
                .padding(10)
                .background(Palette.railNavyTint)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            StatusPill(departureStatus(departure), tone: departureTone(departure))
        }
    }
}

struct StationField: View {
    let label: String
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabelText(label)
            TextField("WAT", text: $value)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.title3.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(Color.white)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.black.opacity(0.08))
                )
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct Card<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Palette.railNavy.opacity(0.08), radius: 12, x: 0, y: 4)
    }
}

struct NoticeCard: View {
    let title: String
    let message: String

    init(title: String, body: String) {
        self.title = title
        self.message = body
    }

    var body: some View {
        Card {
            Text(title)
                .font(.title3.weight(.bold))
            Text(message)
                .foregroundStyle(Palette.inkMuted)
        }
    }
}

struct StatusRow: View {
    let label: String
    let ok: Bool?

    var body: some View {
        HStack {
            Text(label)
                .font(.body.weight(.semibold))
            Spacer()
            StatusPill(ok == nil ? "Not checked" : ok == true ? "OK" : "Down", tone: ok == nil ? .neutral : ok == true ? .good : .bad)
        }
        .padding(.top, 8)
    }
}

enum PillTone {
    case neutral
    case good
    case warn
    case bad
}

struct StatusPill: View {
    let label: String
    let tone: PillTone

    init(_ label: String, tone: PillTone) {
        self.label = label
        self.tone = tone
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(foreground)
            .background(background)
            .clipShape(Capsule())
    }

    private var foreground: Color {
        switch tone {
        case .neutral: return Palette.railNavy
        case .good: return Palette.signalGreen
        case .warn: return Palette.signalAmber
        case .bad: return Palette.signalRed
        }
    }

    private var background: Color {
        foreground.opacity(tone == .neutral ? 0.12 : 0.10)
    }
}

struct LabelText: View {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    var body: some View {
        Text(value.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(1.3)
            .foregroundStyle(Palette.inkMuted)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.white)
            .frame(minHeight: 48)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .background(Palette.railNavy.opacity(configuration.isPressed ? 0.88 : 1))
            .clipShape(Capsule())
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Palette.railNavy)
            .frame(minHeight: 46)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .background(Palette.railNavyTint.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(Capsule())
    }
}

private func statusLabel(_ journey: Journey) -> String {
    if journey.status == "cancelled" { return "Cancelled" }
    if let delay = journey.delayMinutes { return "\(delay) min late" }
    if journey.status == "on-time" { return "On time" }
    return "Scheduled"
}

private func departureStatus(_ departure: Departure) -> String {
    if departure.status == "cancelled" { return "Cancelled" }
    if let delay = departure.delayMinutes { return "\(delay) min late" }
    if departure.status == "on-time" { return "On time" }
    return departure.hasLive ? "Expected" : "Scheduled"
}

private func departureTone(_ departure: Departure) -> PillTone {
    if departure.status == "cancelled" { return .bad }
    if departure.status == "delayed" { return .warn }
    return .good
}

private func failureTitle(_ reason: String?) -> String {
    switch reason {
    case "engine-offline": return "Routing is offline"
    case "no-journeys": return "No journeys found"
    default: return "Check the station codes"
    }
}

private func boardFailureTitle(_ reason: String?) -> String {
    switch reason {
    case "unknown-station": return "Unknown station"
    case "engine-offline": return "Board source offline"
    default: return "Check the station code"
    }
}
