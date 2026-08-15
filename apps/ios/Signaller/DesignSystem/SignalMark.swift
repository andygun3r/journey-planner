import SwiftUI

/// Signaller's mark: three block sections of a running line, the middle one
/// occupied.
///
/// This is the signaller's core mental model — the line divided into blocks,
/// one train per block, and the job is knowing which block is occupied. It is
/// what the app is actually about.
///
/// It replaces the banner-repeater disc from the original brand handoff. That
/// mark was faithful to a real piece of rail equipment, but a circle with a 45°
/// bar through it is also the universal negation glyph: as an app icon, with no
/// wordmark or rail context to disambiguate it, it read as "no entry". The
/// blocks carry the same idea — a signal at clear means the block ahead is
/// free — without a shape that says the opposite of what it means.
///
/// Construction, on a 100-unit grid:
/// - three blocks, vertically centred, 34 units tall
/// - clear blocks 13 wide at x=15 and x=78; the occupied block 26 wide at x=41
/// - corner radius 4 units, matching the brand's rounded form language
///
/// The occupied block is wider because a train occupies a section, not a point;
/// it sits slightly forward of centre so the mark reads left-to-right as
/// travel rather than as a symmetrical ornament.
struct SignalMark: View {
    /// White blocks for a navy ground (default), or navy for a light one.
    var inverted = false

    /// Whether the occupied block shows in Signal Red.
    ///
    /// On by default. Set false where the mark must be single-colour — a
    /// monochrome context, or anywhere red would break the one-accent rule.
    var showsOccupancy = true

    private var clearColor: Color { inverted ? Palette.railNavy : .white }
    private var occupiedColor: Color {
        showsOccupancy ? Palette.signalRed : clearColor
    }

    /// x-centre, width, and whether this block is occupied.
    private static let blocks: [(x: CGFloat, width: CGFloat, occupied: Bool)] = [
        (15, 13, false),
        (41, 26, true),
        (78, 13, false),
    ]

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 100
            context.scaleBy(x: scale, y: scale)

            for block in Self.blocks {
                let rect = CGRect(
                    x: block.x - block.width / 2, y: 50 - 34 / 2,
                    width: block.width, height: 34
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: 4),
                    with: .color(block.occupied ? occupiedColor : clearColor)
                )
            }
        }
        .accessibilityHidden(true)
    }
}

/// Mark plus wordmark, for a navy header band.
///
/// Below 24pt the mark carries alone with no wordmark, so this lockup is only
/// used where there's room for both.
struct SignalLockup: View {
    var markHeight: CGFloat = 22

    var body: some View {
        HStack(spacing: 10) {
            // The mark is wider than it is tall, so it's sized by height and
            // given its natural 100:34 ratio rather than a square frame.
            SignalMark()
                .frame(width: markHeight * (100 / 34), height: markHeight)
            Text("Signaller")
                .font(.system(size: markHeight * 1.05, weight: .heavy))
                .kerning(-0.2)
                .foregroundStyle(Palette.onNavy)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Signaller")
    }
}

#Preview("On navy") {
    VStack(spacing: 28) {
        SignalLockup()
        SignalMark().frame(width: 100, height: 34)
        SignalMark(showsOccupancy: false).frame(width: 100, height: 34)
    }
    .padding(40)
    .background(Palette.railNavy)
}

#Preview("On light") {
    VStack(spacing: 28) {
        SignalMark(inverted: true).frame(width: 100, height: 34)
        SignalMark(inverted: true, showsOccupancy: false).frame(width: 100, height: 34)
    }
    .padding(40)
    .background(Palette.background)
}
