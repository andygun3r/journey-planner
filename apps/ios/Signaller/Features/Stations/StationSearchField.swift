import SwiftUI

/// What the user picked as one end of a journey.
enum JourneyEndpoint: Hashable {
    case station(crs: String, name: String)
    case place(id: String, label: String)

    /// The value the API expects for `from`/`to`.
    var queryValue: String {
        switch self {
        case let .station(crs, _): return crs
        case let .place(id, _): return "place:\(id)"
        }
    }

    var displayName: String {
        switch self {
        case let .station(_, name): return name
        case let .place(_, label): return label
        }
    }
}

/// Typeahead for a station, address or postcode.
///
/// Replaces the old raw-CRS text field, which required users to know that
/// Waterloo is "WAT".
struct StationSearchField: View {
    let label: String
    @Binding var selection: JourneyEndpoint?

    @State private var query = ""
    @State private var results = StationSearchResponse(stations: [], places: [])
    @State private var searching = false
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    @Environment(AppEnvironment.self) private var env

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabelText(label)

            TextField("Station, postcode or address", text: $query)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .font(.title3.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(Palette.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.black.opacity(0.08))
                )
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .focused($focused)
                .onChange(of: query) { _, newValue in scheduleSearch(newValue) }

            if focused, !results.isEmpty {
                resultsList
            }
        }
        .onAppear {
            if let selection, query.isEmpty { query = selection.displayName }
        }
    }

    private var resultsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Stations first, always. Never merged into one ranked list with
            // places — this is a rail app, and a station must not lose its
            // position to a similarly-named shop.
            ForEach(results.stations) { station in
                resultRow(
                    title: station.name,
                    subtitle: station.crs,
                    systemImage: "tram.fill"
                ) {
                    choose(.station(crs: station.crs, name: station.name), display: station.name)
                }
            }

            if !results.places.isEmpty {
                if !results.stations.isEmpty { Divider().padding(.leading, 44) }
                ForEach(results.places) { place in
                    resultRow(
                        title: place.shortLabel,
                        subtitle: place.postcode ?? "Address",
                        systemImage: "mappin.and.ellipse"
                    ) {
                        choose(.place(id: place.id, label: place.shortLabel), display: place.shortLabel)
                    }
                }
            }
        }
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: Palette.railNavy.opacity(0.08), radius: 10, y: 3)
    }

    private func resultRow(
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .foregroundStyle(Palette.inkMuted)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Palette.inkMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 48)   // ≥44pt touch target
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ endpoint: JourneyEndpoint, display: String) {
        selection = endpoint
        query = display
        results = StationSearchResponse(stations: [], places: [])
        focused = false
    }

    /// Debounced so typing "Waterloo" is one request, not eight — places come
    /// from a metered API.
    private func scheduleSearch(_ text: String) {
        searchTask?.cancel()
        // Typing after choosing means the old selection no longer matches.
        if let selection, text != selection.displayName { self.selection = nil }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            results = StationSearchResponse(stations: [], places: [])
            return
        }

        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            // A failed lookup shouldn't clear what's on screen or shout at the
            // user mid-keystroke; the field just stops offering suggestions.
            if let found = try? await env.api.stations(query: trimmed), !Task.isCancelled {
                results = found
            }
        }
    }
}
