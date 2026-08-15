import SwiftUI

/// Signaller's mark: a UK rail banner repeater signal — a white disc, rimmed in
/// navy, with a solid navy arm through its centre, fixed at the "off"/clear
/// angle (45°).
///
/// Construction is from the brand handoff (`data/design/README.md`) and matches
/// [signal-mark.tsx](apps/web/components/signal-mark.tsx) unit for unit, so the
/// app icon and the website's header draw the same object:
///
/// - arm width = 130% of disc diameter
/// - arm thickness = 13% of disc diameter
/// - rim = 5% of disc diameter
///
/// The arm is only ever shown at 45°, never recoloured, stretched or thinned.
struct SignalMark: View {
    /// White disc with a navy arm (default), or the inverse for navy grounds.
    var inverted = false

    private var discColor: Color { inverted ? Palette.railNavy : .white }
    private var strokeColor: Color { inverted ? .white : Palette.railNavy }

    var body: some View {
        Canvas { context, size in
            // Drawn on a 100-unit grid, then scaled — the same viewBox the web
            // mark uses, so proportions can be checked against the handoff.
            //
            // The arm spans 130% of the disc diameter, so the grid is sized to
            // the *arm*, not the disc: on the diagonal the arm reaches
            // 65 * cos(45°) ≈ 46 units from centre in each axis. A disc of 66
            // units leaves that overhang room inside the frame. Sizing the grid
            // to the disc instead clips the overhang, and without the overhang
            // the mark collapses into a plain slashed circle — a "no entry"
            // sign rather than a signal arm at clear.
            let scale = min(size.width, size.height) / 100
            context.scaleBy(x: scale, y: scale)

            let discD: CGFloat = 66
            let rim = discD * 0.05
            let origin = (100 - discD) / 2
            let disc = Path(ellipseIn: CGRect(
                x: origin + rim / 2, y: origin + rim / 2,
                width: discD - rim, height: discD - rim
            ))
            context.fill(disc, with: .color(discColor))
            context.stroke(disc, with: .color(strokeColor), lineWidth: rim)

            // The arm: 130% of the disc diameter long, 13% thick, rotated to
            // the "off"/clear position — up to the right. It deliberately
            // overhangs the disc at both ends.
            context.drawLayer { layer in
                layer.translateBy(x: 50, y: 50)
                layer.rotate(by: .degrees(-45))
                let length = discD * 1.30
                let thickness = discD * 0.13
                layer.fill(
                    Path(CGRect(
                        x: -length / 2, y: -thickness / 2,
                        width: length, height: thickness
                    )),
                    with: .color(strokeColor)
                )
            }
        }
        .accessibilityHidden(true)
    }
}

/// Mark plus wordmark, for a navy header band.
///
/// Below 24pt the mark carries alone with no wordmark (brand minimum size), so
/// this lockup is only used where there's room for both.
struct SignalLockup: View {
    var markSize: CGFloat = 28

    var body: some View {
        HStack(spacing: 9) {
            SignalMark()
                .frame(width: markSize, height: markSize)
            Text("Signaller")
                .font(.system(size: markSize * 0.68, weight: .heavy))
                .kerning(-0.2)
                .foregroundStyle(Palette.onNavy)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Signaller")
    }
}

#Preview("On navy") {
    VStack(spacing: 24) {
        SignalLockup()
        SignalMark().frame(width: 64, height: 64)
        SignalMark(inverted: true).frame(width: 64, height: 64)
    }
    .padding(40)
    .background(Palette.railNavy)
}
