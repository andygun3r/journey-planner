import SwiftUI
import Testing
@testable import Signaller

/// Locks the palette to the brand handoff in `data/design/README.md`.
///
/// These exist because every colour in the app was previously wrong. The
/// palette had been written as 2-decimal RGB floats — Rail Navy came out
/// #1C2440 instead of #1C2340, Signal Red #D6362B instead of #D6352C, and so
/// on for all seven. Each was close enough to look right and wrong enough that
/// no colour on screen was actually the brand colour. Eyeballed floats can't
/// be checked against a handoff; hex can.
@Suite("Brand palette")
@MainActor
struct PaletteTests {
    /// Resolves a SwiftUI colour to 8-bit sRGB components.
    private func rgb(_ color: Color) -> (r: Int, g: Int, b: Int) {
        let resolved = UIColor(color)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }

    private func expect(_ color: Color, isHex hex: UInt32, _ name: String) {
        let got = rgb(color)
        let want = (r: Int((hex >> 16) & 0xFF), g: Int((hex >> 8) & 0xFF), b: Int(hex & 0xFF))
        #expect(
            got == want,
            "\(name): got #\(String(format: "%02X%02X%02X", got.r, got.g, got.b)), want #\(String(format: "%06X", hex))"
        )
    }

    @Test("brand colours match the handoff exactly")
    func brandColors() {
        expect(Palette.railNavy, isHex: 0x1C2340, "Rail Navy")
        expect(Palette.railNavyDeep, isHex: 0x14161F, "Rail Navy Deep")
        expect(Palette.railNavyTint, isHex: 0xE7E8EE, "Rail Navy Tint")
        expect(Palette.signalRed, isHex: 0xD6352C, "Signal Red")
        expect(Palette.signalRedDeep, isHex: 0xB23A2E, "Signal Red Deep")
        expect(Palette.platformWhite, isHex: 0xF6F4F0, "Platform White")
        expect(Palette.ink, isHex: 0x14161F, "Ink")
        expect(Palette.inkMuted, isHex: 0x4A4E5C, "Ink Muted")
        expect(Palette.signalGreen, isHex: 0x2E7D46, "Signal Green")
        expect(Palette.signalAmber, isHex: 0xA05500, "Signal Amber")
    }

    /// WCAG 2.2 AA body text, which PRODUCT.md commits to.
    ///
    /// Worth testing rather than assuming: the brand's own "minor delay"
    /// amber (#E4B676) is a status *dot* colour and lands at 1.9:1 as text on
    /// white. The palette uses a darkened #A05500 for anything that carries
    /// words, which is why `signalAmber` passes here.
    @Test("status and text colours clear 4.5:1 on the surfaces they're used on")
    func contrast() {
        func luminance(_ c: (r: Int, g: Int, b: Int)) -> Double {
            func channel(_ v: Int) -> Double {
                let s = Double(v) / 255
                return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
        }
        func ratio(_ a: Color, _ b: Color) -> Double {
            let la = luminance(rgb(a)), lb = luminance(rgb(b))
            return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
        }

        // Every colour the app draws *words* in, on both light grounds. Note
        // `signalRedText`, not `signalRed`: full-strength Signal Red manages
        // 4.77:1 on a white card but only 4.34:1 on the Platform White page
        // ground, so it stays a fill colour and the deep variant carries text.
        for (name, color) in [
            ("ink", Palette.ink), ("inkMuted", Palette.inkMuted),
            ("railNavy", Palette.railNavy), ("signalGreen", Palette.signalGreen),
            ("signalAmber", Palette.signalAmber), ("signalRedText", Palette.signalRedText),
        ] {
            for (surfaceName, surface) in [
                ("surface", Palette.surface), ("background", Palette.background),
            ] {
                let r = ratio(color, surface)
                #expect(r >= 4.5, "\(name) on \(surfaceName): \(String(format: "%.2f", r)):1")
            }
        }

        // The navy header band and primary buttons.
        #expect(ratio(Palette.onNavy, Palette.railNavy) >= 4.5)

        // Every status pill's text, on both grounds it can sit on.
        for tone in [PillTone.neutral, .good, .warn, .bad] {
            for (surfaceName, surface) in [
                ("surface", Palette.surface), ("background", Palette.background),
            ] {
                let r = ratio(tone.color, surface)
                #expect(r >= 4.5, "\(tone) pill text on \(surfaceName): \(String(format: "%.2f", r)):1")
            }
        }
    }

    /// The navy ground `HeroCard` introduced.
    ///
    /// A third surface, and the contrast maths runs the other way on it: the
    /// pill is a near-white capsule rather than a 10% tint, and Signal Green
    /// lands at 4.34:1 there — the same trap `signalRedText` exists for, which
    /// is why `signalGreenText` was added. Every one of these was verified
    /// numerically before the colour was chosen, not eyeballed.
    @Test("pill text clears 4.5:1 on a hero card's navy ground")
    func contrastOnNavy() {
        func luminance(_ c: (r: Int, g: Int, b: Int)) -> Double {
            func channel(_ v: Int) -> Double {
                let s = Double(v) / 255
                return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
        }
        func ratio(_ a: (r: Int, g: Int, b: Int), _ b: (r: Int, g: Int, b: Int)) -> Double {
            let la = luminance(a), lb = luminance(b)
            return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
        }
        /// `fg` at `alpha` composited over `bg`.
        func over(_ fg: (r: Int, g: Int, b: Int), _ bg: (r: Int, g: Int, b: Int), _ alpha: Double)
            -> (r: Int, g: Int, b: Int) {
            (
                r: Int((Double(fg.r) * alpha + Double(bg.r) * (1 - alpha)).rounded()),
                g: Int((Double(fg.g) * alpha + Double(bg.g) * (1 - alpha)).rounded()),
                b: Int((Double(fg.b) * alpha + Double(bg.b) * (1 - alpha)).rounded())
            )
        }

        let navy = rgb(Palette.railNavy)
        // What `StatusPill` actually draws on navy: white at 92%.
        let pillGround = over(rgb(Palette.onNavy), navy, 0.92)

        for tone in [PillTone.neutral, .good, .warn, .bad] {
            let r = ratio(rgb(tone.onNavyColor), pillGround)
            #expect(r >= 4.5, "\(tone) pill text on a hero pill: \(String(format: "%.2f", r)):1")
        }

        // Signal Green is exactly the case this exists for — it passes on a
        // card and fails here, so `.good` must not use it on navy.
        #expect(ratio(rgb(Palette.signalGreen), pillGround) < 4.5)
        #expect(rgb(PillTone.good.onNavyColor) == rgb(Palette.signalGreenText))

        // Body text and the section label on the navy ground itself.
        #expect(ratio(rgb(Palette.onNavy), navy) >= 4.5)
        #expect(ratio(over(rgb(Palette.onNavy), navy, 0.75), navy) >= 4.5)

        // The hero's primary action inverts to white-on-navy. The standard
        // navy button would be 1.00:1 — invisible — on this ground.
        #expect(ratio(navy, navy) < 4.5)
    }

    /// The one tone whose text and fill differ, and why.
    @Test("bad status draws text in deep red but keeps Signal Red for fills")
    func badToneSplitsTextAndFill() {
        #expect(rgb(PillTone.bad.color) == rgb(Palette.signalRedDeep))
        // Signal Red keeps its spotlight role everywhere it isn't a word.
        #expect(rgb(PillTone.bad.fillColor) == rgb(Palette.signalRed))
        // Every other tone uses one colour for both.
        for tone in [PillTone.neutral, .good, .warn] {
            #expect(rgb(tone.color) == rgb(tone.fillColor))
        }
    }

    /// Every tone states its condition in words *and* offers a symbol, so
    /// status is never carried by colour alone (PRODUCT.md, WCAG 2.2 AA).
    @Test("every status tone has a non-colour cue")
    func nonColorCues() {
        for tone in [PillTone.neutral, .good, .warn, .bad] {
            #expect(!tone.symbolName.isEmpty)
            #expect(UIImage(systemName: tone.symbolName) != nil, "\(tone.symbolName) is a real SF Symbol")
        }
    }
}
