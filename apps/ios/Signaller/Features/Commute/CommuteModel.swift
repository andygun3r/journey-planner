import Foundation
import Observation

/// Drives the commute dashboard, including the live alert stream.
@Observable
@MainActor
final class CommuteModel {
    enum Phase {
        case loading
        case loaded(DashboardState)
        case failed(APIError)
    }

    private(set) var phase: Phase = .loading
    private(set) var alerts: [AlertItem] = []
    private(set) var live: LiveChannel?
    /// Set when starting or ending a run fails, so the button can explain itself.
    var actionError: String?

    private var selectedCommuteId: String?

    var unseenCount: Int { alerts.filter(\.isUnseen).count }

    func load(using api: APIClient) async {
        do {
            let response = try await api.commuteDashboard(commuteId: selectedCommuteId)
            phase = .loaded(response.state)
        } catch let error as APIError {
            phase = .failed(error)
        } catch {
            phase = .failed(.transport(error.localizedDescription))
        }
        await loadAlerts(using: api)
    }

    func select(commuteId: String, api: APIClient) async {
        selectedCommuteId = commuteId
        phase = .loading
        await load(using: api)
    }

    func loadAlerts(using api: APIClient) async {
        // A failed alert fetch shouldn't blank the dashboard — keep whatever
        // was last shown.
        if let response = try? await api.alerts() {
            alerts = response.alerts
        }
    }

    func markAlertsSeen(using api: APIClient) async {
        try? await api.markAlertsSeen()
        await loadAlerts(using: api)
    }

    // MARK: - Runs

    func startRun(_ dashboard: ActiveDashboard, using api: APIClient) async {
        do {
            actionError = nil
            try await api.startRun(
                commuteId: dashboard.commuteId,
                legId: dashboard.leg.legId,
                direction: dashboard.leg.direction,
                originCrs: dashboard.leg.originCrs,
                originLabel: dashboard.leg.originLabel,
                destCrs: dashboard.leg.destCrs,
                destLabel: dashboard.leg.destLabel
            )
            await load(using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func endRun(commuteId: String, using api: APIClient) async {
        do {
            actionError = nil
            try await api.endRun(commuteId: commuteId)
            await load(using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Live alerts

    /// Subscribes to the alert stream so a disruption appears without a refresh.
    func startLive(api: APIClient, auth: AuthStore) {
        guard live == nil else { return }
        let channel = LiveChannel(
            path: "/api/commute/stream",
            api: api,
            auth: auth
        ) { [weak self] event in
            guard event.name == "alert" else { return }
            // The payload is relayed verbatim from Redis. Rather than trust it
            // to be a complete AlertItem, re-fetch — the list is small and this
            // keeps one source of truth for what the user has seen.
            Task { @MainActor [weak self] in
                await self?.loadAlerts(using: api)
            }
        }
        live = channel
        channel.start()
    }

    func stopLive() {
        live?.stop()
        live = nil
    }

    /// Polls when the stream is unavailable — the server has no Redis, so
    /// alerts will never arrive by push on this deployment.
    var shouldPoll: Bool { live?.state.needsPolling ?? true }
}
