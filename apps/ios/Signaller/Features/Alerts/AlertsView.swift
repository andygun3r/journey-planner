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
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 4)
        // One stop per alert, with the unread state in the sentence rather
        // than as a separate unlabelled dot.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenLabel)
    }

    private var spokenLabel: String {
        var parts: [String] = []
        if alert.isUnseen { parts.append("Unread") }
        parts.append(alert.headline)
        if let detail = alert.detail, !detail.isEmpty { parts.append(detail) }
        parts.append(alert.kindLabel)
        parts.append(alert.createdAt.formatted(.relative(presentation: .named)))
        return parts.joined(separator: ". ")
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

    /// Set when an action failed, so nothing silently reverts.
    var actionError: String?

    func markAllSeen(using api: APIClient) async {
        do {
            actionError = nil
            try await api.markAlertsSeen()
            await load(using: api)
        } catch {
            // Swallowing this meant the reload put every alert back as unseen:
            // the action visibly undid itself with no explanation.
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Marks a single alert seen.
    ///
    /// The blanket PATCH was the only option before, so reading one disruption
    /// cleared the entire history — including alerts the user hadn't seen.
    func markSeen(_ alert: AlertItem, using api: APIClient) async {
        guard alert.isUnseen else { return }
        do {
            actionError = nil
            try await api.markAlertSeen(id: alert.id)
            await load(using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
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

            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRedText)
            }

            if !model.alerts.isEmpty {
                Card {
                    ForEach(model.alerts) { alert in
                        // Tapping an unread alert marks just that one, rather
                        // than clearing the whole history.
                        if alert.isUnseen {
                            Button {
                                Task { await model.markSeen(alert, using: env.api) }
                            } label: {
                                AlertRow(alert: alert)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Marks this alert as read")
                        } else {
                            AlertRow(alert: alert)
                        }
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
