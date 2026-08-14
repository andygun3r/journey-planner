import SwiftUI
import Observation

@Observable
@MainActor
final class StatusModel {
    private(set) var health: HealthResponse?
    private(set) var error: APIError?
    private(set) var loading = false

    func refresh(using api: APIClient) async {
        loading = true
        defer { loading = false }
        do {
            health = try await api.health()
            error = nil
        } catch let apiError as APIError {
            // /api/health answers 503 when a dependency is down, so a failure
            // here is itself the status — record it rather than hiding it.
            health = nil
            error = apiError
        } catch {
            self.health = nil
            self.error = .transport(error.localizedDescription)
        }
    }
}

struct StatusView: View {
    @State private var model = StatusModel()
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Status") {
            Card {
                LabelText("Backend")
                Text(env.api.baseURL.absoluteString)
                    .font(.caption)
                    .foregroundStyle(Palette.inkMuted)
                    .textSelection(.enabled)

                if let health = model.health {
                    StatusRow(label: "Postgres", ok: health.postgres)
                    StatusRow(label: "Redis", ok: health.redis)
                    StatusRow(label: "Schema", ok: health.schema)
                    if let timetable = health.timetable {
                        StatusRow(label: "Timetable", ok: timetable)
                    }
                } else if model.loading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Checking…").foregroundStyle(Palette.inkMuted)
                    }
                }
            }

            if let error = model.error {
                EmptyStateCard(
                    title: "Backend unavailable",
                    message: error.errorDescription ?? "Couldn't reach Signaller.",
                    systemImage: "exclamationmark.triangle",
                    retry: { Task { await model.refresh(using: env.api) } }
                )
            }
        }
        .task { await model.refresh(using: env.api) }
        .refreshable { await model.refresh(using: env.api) }
    }
}
