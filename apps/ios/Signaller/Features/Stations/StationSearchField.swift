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

    /// Whether addresses and postcodes are offered alongside stations.
    ///
    /// Off for the departure board, which can only show a station — offering a
    /// postcode there produced a selection the board then silently refused to
    /// load, leaving an enabled button that did nothing.
    var includePlaces = true

    @State private var query = ""
    @State private var results = StationSearchResponse(stations: [], places: [])
    @State private var searching = false
    /// Set when the address lookup failed, so the missing places section is
    /// explained rather than silently absent.
    @State private var placesUnavailable = false
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    @Environment(AppEnvironment.self) private var env

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabelText(label)

            // The placeholder has to match what the field will actually
            // accept — promising postcodes on a stations-only field is the
            // same broken promise as the button that did nothing.
            TextField(
                includePlaces ? "Station, postcode or address" : "Station name or code",
                text: $query
            )
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
                // `searching` used to be set and never read, so on a slow
                // connection the field looked inert for 250ms plus a round trip.
                .overlay(alignment: .trailing) {
                    if searching {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.trailing, 14)
                            .accessibilityLabel("Searching")
                    }
                }

            if focused, !results.isEmpty || placesUnavailable {
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
            } else if placesUnavailable, includePlaces {
                // Places come from a live, metered API and can't be bundled.
                // Say the section is missing rather than letting it look as
                // though no addresses matched.
                if !results.stations.isEmpty { Divider().padding(.leading, 44) }
                HStack(spacing: 12) {
                    Image(systemName: "wifi.slash")
                        .foregroundStyle(Palette.inkMuted)
                        .frame(width: 20)
                        .accessibilityHidden(true)
                    Text("Addresses need a connection")
                        .font(.caption)
                        .foregroundStyle(Palette.inkMuted)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
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

        // Stations come from the on-device index immediately — no debounce, no
        // round trip. This is what makes the field work with no signal, and
        // it's also why it now feels instant when online.
        let localStations = env.stations.search(trimmed)
        results = StationSearchResponse(stations: localStations, places: [])

        // Only places need the network, so only they wait.
        guard includePlaces else { return }

        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            // A failed lookup shouldn't clear what's on screen or shout at the
            // user mid-keystroke; the local stations stay, and `placesOffline`
            // says why the address section is missing rather than omitting it
            // silently.
            do {
                let found = try await env.api.stations(query: trimmed, includePlaces: true)
                guard !Task.isCancelled else { return }
                results = found
                placesUnavailable = false
            } catch {
                guard !Task.isCancelled else { return }
                placesUnavailable = true
            }
        }
    }
}
