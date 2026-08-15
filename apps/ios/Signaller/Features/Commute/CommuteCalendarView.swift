import Observation
import SwiftUI

@Observable
@MainActor
final class CalendarModel {
    private(set) var overrides: [String: CommuteOverride] = [:]
    private(set) var loading = false
    var actionError: String?

    /// The fortnight from today — the window a commuter actually plans in.
    /// Further ahead than that is a sit-down task for the web editor.
    let days: [Date] = {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        return (0..<14).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }()

    func load(commuteId: String, using api: APIClient) async {
        guard let first = days.first, let last = days.last else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await api.overrides(
                commuteId: commuteId,
                from: String.isoDate(from: first),
                to: String.isoDate(from: last)
            )
            overrides = Dictionary(uniqueKeysWithValues: response.overrides.map { ($0.date, $0) })
            actionError = nil
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func override(for date: Date) -> CommuteOverride? {
        overrides[String.isoDate(from: date)]
    }

    /// Marks a day as not commuting, or clears it if it already is.
    func toggleSkip(
        date: Date,
        scope: OverrideScope,
        commuteId: String,
        using api: APIClient
    ) async {
        let iso = String.isoDate(from: date)
        let alreadySkipped = overrides[iso]?.skipped == true
        actionError = nil
        do {
            if alreadySkipped, scope == .thisDay {
                try await api.clearOverride(commuteId: commuteId, date: iso)
            } else {
                try await api.saveOverride(
                    commuteId: commuteId,
                    date: iso,
                    scope: scope,
                    skipped: !alreadySkipped
                )
            }
            await load(commuteId: commuteId, using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func clear(date: Date, commuteId: String, using api: APIClient) async {
        actionError = nil
        do {
            try await api.clearOverride(commuteId: commuteId, date: String.isoDate(from: date))
            await load(commuteId: commuteId, using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// The next fortnight, and which days you're not commuting.
///
/// "I'm working from home tomorrow" is the most phone-shaped commute action
/// there is — decided the night before, one tap — and it was web-only.
struct CommuteCalendarView: View {
    let commuteId: String
    let commuteLabel: String

    @State private var model = CalendarModel()
    @Environment(AppEnvironment.self) private var env
    @State private var scopePrompt: Date?

    var body: some View {
        AppChrome(title: "Calendar", lazy: true) {
            Card {
                Text(commuteLabel).font(.title3.weight(.bold))
                Text("Tap a day you're not commuting. Alerts pause for those days.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
            }

            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRedText)
            }

            Card {
                ForEach(Array(model.days.enumerated()), id: \.element) { index, day in
                    dayRow(day)
                    if index < model.days.count - 1 { Divider() }
                }
            }
        }
        .task { await model.load(commuteId: commuteId, using: env.api) }
        .refreshable { await model.load(commuteId: commuteId, using: env.api) }
        .confirmationDialog(
            "Not commuting",
            isPresented: Binding(
                get: { scopePrompt != nil },
                set: { if !$0 { scopePrompt = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let day = scopePrompt {
                // The this-day / all-future choice the web calendar offers.
                // Defaulting silently to either one would be a guess about
                // something the user cares about.
                Button(OverrideScope.thisDay.label) {
                    Task {
                        await model.toggleSkip(
                            date: day, scope: .thisDay, commuteId: commuteId, using: env.api
                        )
                    }
                }
                Button("Every \(day.formatted(.dateTime.weekday(.wide))) from now on") {
                    Task {
                        await model.toggleSkip(
                            date: day, scope: .futureWeekdays, commuteId: commuteId, using: env.api
                        )
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func dayRow(_ day: Date) -> some View {
        let override = model.override(for: day)
        let skipped = override?.skipped == true

        return Button {
            if skipped {
                Task { await model.clear(date: day, commuteId: commuteId, using: env.api) }
            } else {
                scopePrompt = day
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(day.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
                        .font(.body.weight(.medium))
                        .foregroundStyle(skipped ? Palette.inkMuted : Palette.ink)
                    if let override, !override.isEmpty {
                        Text(override.summary)
                            .font(.caption)
                            .foregroundStyle(Palette.signalAmber)
                    } else if Calendar.current.isDateInToday(day) {
                        Text("Today").font(.caption).foregroundStyle(Palette.inkMuted)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: skipped ? "xmark.circle.fill" : "circle")
                    .foregroundStyle(skipped ? Palette.signalAmber : Palette.inkMuted)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(dayLabel(day, override: override))
        .accessibilityHint(skipped ? "Restores your normal commute" : "Marks the day as not commuting")
    }

    private func dayLabel(_ day: Date, override: CommuteOverride?) -> String {
        var parts = [day.formatted(.dateTime.weekday(.wide).day().month(.wide))]
        if Calendar.current.isDateInToday(day) { parts.append("today") }
        if let override, !override.isEmpty {
            parts.append(override.summary)
        } else {
            parts.append("commuting as normal")
        }
        return parts.joined(separator: ", ")
    }
}
