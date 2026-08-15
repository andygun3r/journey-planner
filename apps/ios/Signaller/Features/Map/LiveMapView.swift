import MapKit
import SwiftUI

/// Live trains on Apple Maps.
///
/// MapKit rather than the web app's OpenRailwayMap tiles: it can't consume a
/// MapLibre style, so this shows Apple's basemap with trains as annotations
/// instead of ORM's rail cartography. In exchange there's no dependency, no
/// tile proxy, and native performance and gestures.
struct LiveMapView: View {
    @State private var model = MapModel()
    @State private var camera: MapCameraPosition = .region(Self.greatBritain)
    /// Tracks what's on screen so only visible trains are drawn.
    @State private var visibleRegion: MKCoordinateRegion = Self.greatBritain
    @State private var selected: LiveTrain?

    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase

    /// Opening view: the whole network.
    private static let greatBritain = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 54.0, longitude: -2.5),
        span: MKCoordinateSpan(latitudeDelta: 11, longitudeDelta: 11)
    )

    var body: some View {
        Map(position: $camera, selection: $selected) {
            ForEach(model.visibleTrains(in: visibleRegion)) { train in
                Annotation(
                    train.headcode ?? "",
                    coordinate: train.coordinate,
                    anchor: .center
                ) {
                    TrainMarker(train: train)
                        .onTapGesture { selected = train }
                }
                .tag(train)
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls {
            MapUserLocationButton()
            MapCompass()
        }
        .onMapCameraChange(frequency: .onEnd) { context in
            visibleRegion = context.region
        }
        .overlay(alignment: .top) { statusBar }
        .sheet(item: $selected) { train in
            TrainDetailSheet(train: train)
                .presentationDetents([.height(280), .medium])
        }
        .navigationTitle("Live map")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.start(api: env.api, auth: env.auth)
            // The stream is the primary source; this only fills in when the
            // server has no Redis and reported `unavailable`.
            if model.shouldPoll { await model.poll(using: env.api) }
        }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.start(api: env.api, auth: env.auth)
            case .background, .inactive: model.stop()
            @unknown default: break
            }
        }
    }

    /// Says how much is being shown, and how fresh it is. Silently drawing a
    /// subset of a national feed would misrepresent it.
    private var statusBar: some View {
        let total = model.totalInView(in: visibleRegion)
        let thinned = model.hiddenCount(in: visibleRegion) > 0
        return HStack(spacing: 6) {
            Circle()
                .fill(model.live?.state == .live ? Palette.signalGreen : Palette.inkMuted)
                .frame(width: 6, height: 6)
            // Leads with the true count in view. Saying "250 shown" first
            // reads as though that's all there is.
            Text(thinned
                 ? "\(total) trains · zoom in for all"
                 : "\(total) trains")
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.regularMaterial)
        .clipShape(Capsule())
        .padding(.top, 8)
    }
}

/// One train on the map. Colour carries lateness, but the callout always spells
/// it out — colour is never the only cue.
private struct TrainMarker: View {
    let train: LiveTrain

    var body: some View {
        Image(systemName: "tram.fill")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(5)
            .background(train.tone.color)
            .clipShape(Circle())
            .overlay(
                Circle().stroke(.white, lineWidth: 1.5)
            )
            // A stale position is dimmed as well as labelled in the sheet.
            .opacity(train.isStale ? 0.5 : 1)
            .shadow(radius: 2)
    }
}

/// Tapping a train: what it is, where it is, and a way into the full service.
private struct TrainDetailSheet: View {
    let train: LiveTrain
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AppChrome(title: train.headcode ?? "Train") {
                Card {
                    Text(train.title).font(.title3.weight(.bold))
                    if let operatorName = train.operatorName {
                        Text(operatorName).font(.callout).foregroundStyle(Palette.inkMuted)
                    }

                    HStack(spacing: 8) {
                        StatusPill(train.latenessLabel, tone: train.tone)
                        if train.isStale, let ago = train.reportedAgoSeconds {
                            Text(StatusFormatting.reportedAgo(seconds: ago))
                                .font(.caption)
                                .foregroundStyle(Palette.inkMuted)
                        }
                    }

                    if let at = train.atName {
                        let verb = train.event == "ARRIVAL" ? "Arrived at" : "Left"
                        Text("\(verb) \(at)").font(.callout)
                    }
                    if let toward = train.towardName {
                        Text("Heading for \(toward)")
                            .font(.callout)
                            .foregroundStyle(Palette.inkMuted)
                    }
                }

                // Only a correlated train has a service to open.
                if let rid = train.rid {
                    NavigationLink {
                        ServiceDetailView(departure: .placeholder(rid: rid, destination: train.destName ?? ""))
                    } label: {
                        Text("Full service details").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
