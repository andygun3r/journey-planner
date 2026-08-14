import SwiftUI

struct PlanView: View {
    @State private var model = PlanModel()
    @State private var showingTimePicker = false
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Plan") {
            searchCard
            resultsSection
        }
        .navigationDestination(for: Journey.self) { journey in
            JourneyDetailView(journey: journey)
        }
    }

    private var searchCard: some View {
        Card {
            StationSearchField(label: "From", selection: $model.from)
            HStack {
                StationSearchField(label: "To", selection: $model.to)
                Button {
                    model.swapEnds()
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.railNavy)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Swap origin and destination")
            }

            departureTimeRow

            Button("Find trains") {
                Task { await model.search(using: env.api) }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!model.canSearch || isLoading)
            .padding(.top, 4)
        }
    }

    private var departureTimeRow: some View {
        HStack {
            LabelText("Departing")
            Spacer()
            if model.departAt == nil {
                Button("Now") { showingTimePicker = true }
                    .font(.body.weight(.semibold))
            } else {
                Button(model.departAt?.formatted(.dateTime.weekday().hour().minute()) ?? "") {
                    showingTimePicker = true
                }
                .font(.body.weight(.semibold))
                Button {
                    model.departAt = nil
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.inkMuted)
                }
                .accessibilityLabel("Depart now instead")
            }
        }
        .sheet(isPresented: $showingTimePicker) {
            DeparturePickerSheet(date: $model.departAt)
        }
    }

    @ViewBuilder
    private var resultsSection: some View {
        switch model.phase {
        case .idle:
            EmptyStateCard(
                title: "Where are you going?",
                message: "Search any station, postcode or address.",
                systemImage: "magnifyingglass"
            )
        case .loading:
            Card {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Finding trains…").foregroundStyle(Palette.inkMuted)
                }
            }
        case let .results(journeys):
            ForEach(journeys) { journey in
                NavigationLink(value: journey) {
                    JourneyRow(journey: journey)
                }
                .buttonStyle(.plain)
            }
        case let .empty(reason):
            // Previously a blank screen: nothing was rendered unless `ok` was
            // false, so "no journeys found" looked like a broken app.
            EmptyStateCard(
                title: StatusFormatting.planFailureTitle(reason: reason),
                message: StatusFormatting.planFailureMessage(reason: reason),
                systemImage: "questionmark.circle"
            ) {
                Task { await model.search(using: env.api) }
            }
        case let .failed(error):
            EmptyStateCard(
                title: "Couldn't plan that journey",
                message: error.errorDescription ?? "Something went wrong.",
                systemImage: "exclamationmark.triangle",
                retry: error.isRetryable ? { Task { await model.search(using: env.api) } } : nil
            )
        }
    }

    private var isLoading: Bool {
        if case .loading = model.phase { return true }
        return false
    }
}

private struct DeparturePickerSheet: View {
    @Binding var date: Date?
    @Environment(\.dismiss) private var dismiss
    @State private var draft = Date()

    var body: some View {
        NavigationStack {
            DatePicker("Departure", selection: $draft)
                .datePickerStyle(.graphical)
                .padding()
                .navigationTitle("Depart at")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Set") { date = draft; dismiss() }
                    }
                }
        }
        .onAppear { draft = date ?? Date() }
    }
}
