import SwiftUI

/// Departures and journey planning, in one tab.
///
/// These were two tabs, and they are the same task: pick a station, get times.
/// They differ only in whether you name one end or two. Splitting them cost a
/// tab slot and made the app open on a blank search form, while Commute — the
/// app's namesake, and the only screen anyone opens daily — sat fourth.
///
/// Merging them frees the slot that Status now occupies, and means there is one
/// journey planner in the app rather than one per tab.
struct TrainsView: View {
    @Environment(AppEnvironment.self) private var env

    enum Mode: String, CaseIterable, Hashable {
        case departures
        case journey

        var label: String {
            switch self {
            case .departures: return "Departures"
            case .journey: return "Journey"
            }
        }
    }

    @State private var mode: Mode = .departures

    var body: some View {
        VStack(spacing: 0) {
            Picker("What to show", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .background(Palette.background)

            switch mode {
            case .departures: BoardsView()
            case .journey: PlanView()
            }
        }
        .background(Palette.background)
        // The children set their own titles via `AppChrome`, which would leave
        // the bar reading "Departures" above a Departures/Journey control.
        // The tab names itself; the segment says which half you're on.
        .navigationTitle("Trains")
        // A deep link naming a station wants the board, whichever segment the
        // user last left this tab on.
        .onChange(of: env.pendingBoardCRS, initial: true) { _, crs in
            if crs != nil { mode = .departures }
        }
        .onChange(of: env.pendingServiceID, initial: true) { _, id in
            if id != nil { mode = .departures }
        }
        // "To work" / "to home" from the commute dashboard: the planner is
        // here now, so the button switches tab and segment instead of pushing
        // a second copy of this screen inside Commute.
        .onChange(of: env.pendingJourney, initial: true) { _, query in
            if query != nil { mode = .journey }
        }
    }
}
