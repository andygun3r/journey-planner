import Observation
import SwiftUI

@Observable
@MainActor
final class HolidaysModel {
    private(set) var holidays: [Holiday] = []
    private(set) var loading = false
    var actionError: String?

    func load(using api: APIClient) async {
        loading = true
        defer { loading = false }
        do {
            holidays = try await api.holidays().holidays
            actionError = nil
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func add(start: Date, end: Date, label: String, using api: APIClient) async -> Bool {
        actionError = nil
        do {
            try await api.createHoliday(
                startDate: String.isoDate(from: start),
                endDate: String.isoDate(from: end),
                label: label.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            await load(using: api)
            return true
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }

    func delete(_ holiday: Holiday, using api: APIClient) async {
        actionError = nil
        do {
            try await api.deleteHoliday(id: holiday.id)
            await load(using: api)
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Date ranges where commute alerts are paused.
struct HolidaysView: View {
    @State private var model = HolidaysModel()
    @Environment(AppEnvironment.self) private var env
    @State private var adding = false

    var body: some View {
        AppChrome(title: "Holidays", lazy: true) {
            Card {
                Text("Alerts pause for these dates, so you're not told about a train you're not catching.")
                    .font(.callout)
                    .foregroundStyle(Palette.inkMuted)
                Button("Add holiday") { adding = true }
                    .buttonStyle(PrimaryButtonStyle())
            }

            if let error = model.actionError {
                Text(error).font(.caption).foregroundStyle(Palette.signalRedText)
            }

            if model.holidays.isEmpty, !model.loading {
                EmptyStateCard(
                    title: "No holidays booked",
                    message: "Add dates you're away and commute alerts will pause.",
                    systemImage: "sun.max"
                )
            } else {
                Card {
                    ForEach(model.holidays) { holiday in
                        holidayRow(holiday)
                        if holiday.id != model.holidays.last?.id { Divider() }
                    }
                }
            }
        }
        .task { await model.load(using: env.api) }
        .refreshable { await model.load(using: env.api) }
        .sheet(isPresented: $adding) {
            AddHolidaySheet { start, end, label in
                await model.add(start: start, end: end, label: label, using: env.api)
            }
        }
    }

    private func holidayRow(_ holiday: Holiday) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(holiday.label ?? "Away").font(.body.weight(.medium))
                Text(holiday.dateRangeLabel).font(.caption).foregroundStyle(Palette.inkMuted)
            }
            Spacer(minLength: 0)
            Button(role: .destructive) {
                Task { await model.delete(holiday, using: env.api) }
            } label: {
                Image(systemName: "trash")
                    .foregroundStyle(Palette.signalRedText)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete \(holiday.label ?? "holiday"), \(holiday.dateRangeLabel)")
        }
        .frame(minHeight: 48)
        .accessibilityElement(children: .contain)
    }
}

/// Picking a range, with the same rule the server enforces.
private struct AddHolidaySheet: View {
    let save: (Date, Date, String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var start = Date()
    @State private var end = Date()
    @State private var label = ""
    @State private var saving = false

    /// The server rejects an end before the start; say so here rather than
    /// making the user find out via a 400.
    private var rangeIsValid: Bool {
        Calendar.current.startOfDay(for: end) >= Calendar.current.startOfDay(for: start)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("From", selection: $start, displayedComponents: .date)
                    DatePicker("To", selection: $end, displayedComponents: .date)
                    if !rangeIsValid {
                        Text("The end date must be on or after the start date.")
                            .font(.caption)
                            .foregroundStyle(Palette.signalRedText)
                    }
                }
                Section {
                    TextField("Label (optional)", text: $label)
                }
            }
            .navigationTitle("Add holiday")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            if await save(start, end, label) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(!rangeIsValid || saving)
                }
            }
        }
    }
}
