import SwiftUI

struct PlanView: View {
    /// Pre-filled endpoints, when arriving from a commute quick-start or a
    /// saved journey. Nil for the normal tab.
    var initialQuery: JourneyQuery?

    @State private var model = PlanModel()
    @State private var showingTimePicker = false
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        AppChrome(title: "Plan") {
            searchCard
            savedSection
            resultsSection
        }
        .navigationDestination(for: Journey.self) { journey in
            JourneyDetailView(journey: journey)
        }
        .task {
            await env.favourites.load(using: env.api)
            // Arriving with a pair means the user already chose — search
            // rather than making them press the button again.
            if let initialQuery, model.from == nil, model.to == nil {
                model.from = .station(crs: initialQuery.from, name: initialQuery.from)
                model.to = .station(crs: initialQuery.to, name: initialQuery.to)
                await model.search(using: env.api)
            }
        }
    }

    /// Saved journeys, one tap from a fresh search.
    @ViewBuilder
    private var savedSection: some View {
        if env.auth.isSignedIn, !env.favourites.favourites.isEmpty, isIdle {
            Card {
                LabelText("Saved")
                ForEach(env.favourites.favourites) { favourite in
                    Button {
                        model.from = .station(crs: favourite.from, name: favourite.fromDisplay)
                        model.to = .station(crs: favourite.to, name: favourite.toDisplay)
                        Task { await model.search(using: env.api) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(Palette.signalAmber)
                            Text("\(favourite.fromDisplay) to \(favourite.toDisplay)")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(Palette.ink)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var isIdle: Bool {
        if case .idle = model.phase { return true }
        return false
    }

    private var searchCard: some View {
        Card {
            // The swap control sits between the two fields, level with the
            // boundary, so it reads as acting on the pair rather than on
            // whichever field it happens to sit beside.
            HStack(alignment: .top, spacing: 10) {
                VStack(spacing: 10) {
                    StationSearchField(label: "From", selection: $model.from)
                    StationSearchField(label: "To", selection: $model.to)
                }

                Button {
                    model.swapEnds()
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.railNavy)
                        .frame(width: 44, height: 44)
                        .background(Palette.railNavyTint)
                        .clipShape(Circle())
                }
                .accessibilityLabel("Swap origin and destination")
                // Nudged down to straddle the gap between the two fields.
                .padding(.top, 46)
            }

            departureTimeRow
                .padding(.top, 2)

            HStack(spacing: 10) {
                Button("Find trains") {
                    Task { await model.search(using: env.api) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!model.canSearch || isLoading)

                favouriteButton
            }
            .padding(.top, 4)

            favouriteError
        }
    }

    /// Save this pair. Only meaningful for two stations — a favourite is a
    /// from→to CRS pair, so an address endpoint has nothing to store.
    @ViewBuilder
    private var favouriteButton: some View {
        if env.auth.isSignedIn,
           case let .station(fromCrs, _)? = model.from,
           case let .station(toCrs, _)? = model.to {
            let saved = env.favourites.contains(from: fromCrs, to: toCrs)
            Button {
                Task { await env.favourites.toggle(from: fromCrs, to: toCrs, using: env.api) }
            } label: {
                Image(systemName: saved ? "star.fill" : "star")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(saved ? Palette.signalAmber : Palette.railNavy)
                    .frame(width: 48, height: 48)
                    .background(Palette.railNavyTint)
                    .clipShape(Circle())
            }
            .accessibilityLabel(saved ? "Remove saved journey" : "Save this journey")
        }
    }

    /// Why a star didn't stick. The toggle is optimistic and rolls back on
    /// failure, so without this the star would silently snap back.
    @ViewBuilder
    private var favouriteError: some View {
        if let error = env.favourites.toggleError {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .accessibilityHidden(true)
                Text(error).font(.caption)
            }
            .foregroundStyle(Palette.signalRedText)
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
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.inkMuted)
                        // The glyph is ~22pt; the tap target must be 44pt.
                        // PRODUCT.md calls out gloved, one-handed platform use.
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
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
