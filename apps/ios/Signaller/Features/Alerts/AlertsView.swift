import SwiftUI
import Observation

/// One alert in a list. Unseen alerts carry a leading marker as well as heavier
/// type, so "new" isn't signalled by weight alone.
struct AlertRow: View {
    let alert: AlertItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: alert.symbolName)
                .font(.body)
                .foregroundStyle(alert.tone.color)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(alert.headline)
                    .font(.body.weight(alert.isUnseen ? .semibold : .regular))
                    .foregroundStyle(Palette.ink)
                if let detail = alert.detail, !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(Palette.inkMuted)
                }
                HStack(spacing: 6) {
                    Text(alert.kindLabel)
                    Text("·")
                    Text(alert.createdAt.formatted(.relative(presentation: .named)))
                }
                .font(.caption2)
                .foregroundStyle(Palette.inkMuted)
            }

            Spacer(minLength: 0)

            if alert.isUnseen {
                Circle().fill(Palette.railNavy).frame(width: 8, height: 8).padding(.top, 6)
                    .accessibilityLabel("Unread")
            }
        }
        .padding(.vertical, 4)
    }
}

@Observable
@MainActor
final class AlertsModel {
    private(set) var alerts: [AlertItem] = []
    private(set) var error: APIError?
    private(set) var loading = false

    func load(using api: APIClient) async {
        loading = true
        defer { loading = false }
        do {
            alerts = try await api.alerts().alerts
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .transport(error.localizedDescription)
        }
    }

    func markAllSeen(using api: APIClient) async {
        try? await api.markAlertsSeen()
        await load(using: api)
    }
}

/// The full alert history.
struct AlertsView: View {
    @State private var model = AlertsModel()
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Alerts", lazy: true) {
            if model.alerts.isEmpty, !model.loading, model.error == nil {
                EmptyStateCard(
                    title: "No alerts",
                    message: "You'll see cancellations and delays on your commute here.",
                    systemImage: "bell.slash"
                )
            }

            if let error = model.error {
                EmptyStateCard(
                    title: "Couldn't load alerts",
                    message: error.errorDescription ?? "Something went wrong.",
                    systemImage: "exclamationmark.triangle",
                    retry: { Task { await model.load(using: env.api) } }
                )
            }

            if !model.alerts.isEmpty {
                Card {
                    ForEach(model.alerts) { alert in
                        AlertRow(alert: alert)
                        if alert.id != model.alerts.last?.id { Divider() }
                    }
                }
            }
        }
        .toolbar {
            if model.alerts.contains(where: \.isUnseen) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Mark all seen") {
                        Task { await model.markAllSeen(using: env.api) }
                    }
                }
            }
        }
        .task { await model.load(using: env.api) }
        .refreshable { await model.load(using: env.api) }
    }
}
