import Observation
import SwiftUI

@Observable
@MainActor
final class StatusModel {
    private(set) var status: NetworkStatus?
    private(set) var health: HealthResponse?
    private(set) var error: APIError?
    private(set) var loading = false

    func refresh(using api: APIClient) async {
        loading = true
        defer { loading = false }

        // Network status is the answer people came for; the healthcheck is
        // supporting detail, so a failure in one must not hide the other.
        do {
            status = try await api.networkStatus()
            error = nil
        } catch let apiError as APIError {
            status = nil
            error = apiError
        } catch {
            status = nil
            self.error = .transport(error.localizedDescription)
        }

        health = try? await api.health()
    }
}

/// How the railway is running.
///
/// This was a `/api/health` check — Postgres up, Redis up — which tells a
/// passenger nothing. `/api/status` carries punctuality, per-operator
/// performance, planned engineering work and TfL line status, and had no
/// native caller at all. The healthcheck is still here, demoted to the bottom
/// where a developer can find it.
struct StatusView: View {
    @State private var model = StatusModel()
    @Environment(AppEnvironment.self) private var env
    @State private var showingAllOperators = false

    var body: some View {
        AppChrome(title: "Network status", lazy: true) {
            if let status = model.status {
                nationalCard(status)
                if !status.engineeringWorks.isEmpty { engineeringCard(status.engineeringWorks) }
                operatorsCard(status.operators)
                if !status.tflLines.isEmpty { tflCard(status.tflLines) }
                updatedRow(status)
            } else if model.loading {
                Card {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Checking the network…").foregroundStyle(Palette.inkMuted)
                    }
                }
            }

            if let error = model.error {
                EmptyStateCard(
                    title: "Couldn't load network status",
                    message: error.errorDescription ?? "Couldn't reach Signaller.",
                    systemImage: "exclamationmark.triangle",
                    retry: error.isRetryable ? { Task { await model.refresh(using: env.api) } } : nil
                )
            }

            backendCard
        }
        .task { await model.refresh(using: env.api) }
        .refreshable { await model.refresh(using: env.api) }
    }

    // MARK: - National

    private func nationalCard(_ status: NetworkStatus) -> some View {
        let national = status.national
        return Card {
            HStack {
                Text("Across the network").font(.title3.weight(.bold))
                Spacer()
                StatusPill(national.statusLabel, tone: national.tone)
            }
            if let ppm = national.ppmLabel {
                Text(ppm).font(.largeTitle.weight(.bold)).monospacedDigit()
            }
            // The sample size turns a number into a statistic.
            if let sample = national.sampleLabel {
                Text("Measured over \(sample) in the last hour.")
                    .font(.caption)
                    .foregroundStyle(Palette.inkMuted)
            }
            if let rolling = national.rollingPpm {
                Text("\(rolling)% over a longer window")
                    .font(.caption)
                    .foregroundStyle(Palette.inkMuted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "Across the network: \(national.statusLabel). \(national.ppmLabel ?? "no figure yet")"
        )
    }

    // MARK: - Operators

    private func operatorsCard(_ operators: [OperatorPerformance]) -> some View {
        // Worst first: a list sorted by name buries the operator you need to
        // know about.
        let sorted = operators.sorted { ($0.ppm ?? 101) < ($1.ppm ?? 101) }
        let shown = showingAllOperators ? sorted : Array(sorted.prefix(6))

        return Card {
            LabelText("Operators")
            ForEach(shown) { performance in
                operatorRow(performance)
                if performance.id != shown.last?.id { Divider() }
            }
            if sorted.count > shown.count {
                Button("Show all \(sorted.count) operators") { showingAllOperators = true }
                    .font(.callout.weight(.semibold))
                    .frame(minHeight: 44)
            }
        }
    }

    private func operatorRow(_ performance: OperatorPerformance) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(performance.name).font(.body.weight(.medium)).lineLimit(1)
                    if let sample = performance.sampleLabel {
                        Text(sample).font(.caption2).foregroundStyle(Palette.inkMuted)
                    }
                }
                Spacer(minLength: 0)
                if let ppm = performance.ppm {
                    Text("\(ppm)%").font(.callout.weight(.semibold)).monospacedDigit()
                }
                StatusPill(performance.statusLabel, tone: performance.tone)
            }
            // What's actually wrong beats a percentage, when there is one.
            if let headline = performance.disruptionHeadline {
                Text(headline)
                    .font(.caption)
                    .foregroundStyle(Palette.signalAmber)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(operatorLabel(performance))
    }

    /// Built as statements rather than one chained expression — the concatenated
    /// version defeated the type checker.
    private func operatorLabel(_ performance: OperatorPerformance) -> String {
        var parts: [String] = [performance.name, performance.statusLabel]
        if let ppm = performance.ppmLabel { parts.append(ppm) }
        if let sample = performance.sampleLabel { parts.append("from \(sample)") }
        if let headline = performance.disruptionHeadline { parts.append(headline) }
        return parts.joined(separator: ", ")
    }

    // MARK: - Engineering and TfL

    private func engineeringCard(_ works: [EngineeringWork]) -> some View {
        Card {
            LabelText("Planned engineering work")
            ForEach(works) { work in
                VStack(alignment: .leading, spacing: 2) {
                    if let summary = work.summary {
                        Text(summary).font(.body.weight(.medium))
                    }
                    if let range = work.dateRange {
                        Text(range).font(.caption).foregroundStyle(Palette.inkMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
                if work.id != works.last?.id { Divider() }
            }
        }
    }

    private func tflCard(_ lines: [TflLineStatus]) -> some View {
        // Good Service is the default state; leading with the exceptions is
        // what a Londoner actually needs.
        let disrupted = lines.filter { !$0.isGood }
        return Card {
            LabelText("London Underground")
            if disrupted.isEmpty {
                Text("Good service on all lines.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            } else {
                ForEach(disrupted) { line in
                    HStack {
                        Text(line.lineName).font(.body.weight(.medium))
                        Spacer(minLength: 0)
                        StatusPill(line.statusSeverityDescription, tone: line.tone)
                    }
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(line.lineName): \(line.statusSeverityDescription)")
                    if line.id != disrupted.last?.id { Divider() }
                }
                Text("All other lines have a good service.")
                    .font(.caption)
                    .foregroundStyle(Palette.inkMuted)
            }
        }
    }

    private func updatedRow(_ status: NetworkStatus) -> some View {
        HStack(spacing: 6) {
            Text(StatusFormatting.lastUpdated(secondsAgo: -status.updatedAt.timeIntervalSinceNow))
            if let vstp = status.vstpToday, vstp > 0 {
                Text("· \(vstp) short-notice changes today")
            }
        }
        .font(.caption)
        .foregroundStyle(Palette.inkMuted)
    }

    // MARK: - Backend health (developer detail)

    private var backendCard: some View {
        Card {
            LabelText("App backend")
            Text(env.api.baseURL.absoluteString)
                .font(.caption)
                .foregroundStyle(Palette.inkMuted)
                .textSelection(.enabled)

            if let health = model.health {
                StatusRow(label: "Postgres", ok: health.postgres)
                StatusRow(label: "Redis", ok: health.redis)
                StatusRow(label: "Schema", ok: health.schema)
                if let timetable = health.timetable {
                    StatusRow(label: "Timetable", ok: timetable.ok)
                    if let summary = timetable.summary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(
                                timetable.stale == true ? Palette.signalAmber : Palette.inkMuted
                            )
                    }
                }
            }
        }
    }
}
