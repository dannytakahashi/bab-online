import Foundation

/// My hand's HSI on the table (HSIBadge): when a live deal shows it and the colour it reads in,
/// as the web's GameScene.updatePlayerHsi / clearPlayerHsi (PR #345).
///
/// The colour runs red (weak) through yellow (an average deal) to green (strong): the web's
/// `hsl(120 * clamp((hsi - 70) / 125, 0, 1), 75%, 55%)`, the same hue for the same value on
/// both clients. Over 1M random deals (every hand size of a game) the median HSI is ~127 and
/// the mean ~129, against the scale's yellow midpoint of 132.5; ~9% of hands are at or under 70
/// (full red) and ~8% at or over 195 (full green).
///
/// The one difference: the web's red end (55% lightness) is 3.3:1 on the HSI box, under the
/// 4.5:1 every text-on-surface pair here keeps (Theme.contrastPairs, WCAG AA), so where a hue
/// at 55% would read under 4.5:1 on any of `backings` its lightness is raised just enough
/// (hues under ~20, an HSI under ~90: a lighter, salmon red). From ~90 up the colour is the web's.
enum HSIScale {
    /// A live deal's HSI shows this long after its gameStart ("HSI --" meanwhile): the web's
    /// `director.delay(1000, ...)` from the cards going down, about when the last one lands.
    static let revealDelay: TimeInterval = 1.0

    /// Full red at or under this value.
    static let weak: Double = 70
    /// Full green at or over `weak + span` (195).
    static let span: Double = 125
    static let saturation: Double = 0.75
    static let lightness: Double = 0.55
    /// WCAG AA for the badge's 11 pt text.
    static let minContrast: Double = 4.5

    /// The web's hue: 0 (red) at `weak` and under, 60 (yellow) at 132.5, 120 (green) at 195 and over.
    static func hue(_ hsi: Double) -> Double {
        guard hsi.isFinite else { return 0 }
        return 120 * min(1, max(0, (hsi - weak) / span))
    }

    /// The web's colour for `hsi` (hsl(hue, 75%, 55%)), before any lift for contrast.
    static func webColor(_ hsi: Double) -> ThemeColor { hsl(hue(hsi), saturation, lightness) }

    /// What the badge's text reads in: `webColor`, lightened (same hue and saturation) until it
    /// is `minContrast` on every one of `backings`.
    static func color(_ hsi: Double) -> ThemeColor {
        let h = hue(hsi)
        // 0.5% lightness steps: at most ~22 (pure red needs ~66%)
        for step in 0...80 {
            let c = hsl(h, saturation, lightness + Double(step) * 0.005)
            if backings.allSatisfy({ contrast(c, $0) >= minContrast }) { return c }
        }
        return hsl(h, saturation, 0.95)
    }

    /// What the badge's text sits on, composited opaque: the seat row's pill (surface.s2 @ 0.86,
    /// Theme.contrastPairs' "HSI box") and the bid panel (surface.s1 @ 0.95), each over the
    /// lightest and the darkest felt it can be over (felt.light, felt.edge).
    static let backings: [ThemeColor] = {
        let surfaces = [Theme.Palette.Surface.s2.opacity(0.86), Theme.Palette.Surface.s1.opacity(0.95)]
        let felts = [Theme.Palette.Felt.light, Theme.Palette.Felt.edge]
        return surfaces.flatMap { top in felts.map { over(top, $0) } }
    }()

    // MARK: - Colour math

    /// CSS hsl(): `h` in degrees, `s` and `l` in 0...1, rounded to 8-bit sRGB (as a browser paints it).
    static func hsl(_ h: Double, _ s: Double, _ l: Double) -> ThemeColor {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r, g, b): (Double, Double, Double)
        switch hp {
        case ..<1: (r, g, b) = (c, x, 0)
        case ..<2: (r, g, b) = (x, c, 0)
        case ..<3: (r, g, b) = (0, c, x)
        case ..<4: (r, g, b) = (0, x, c)
        case ..<5: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        let m = l - c / 2
        return rgb(r + m, g + m, b + m)
    }

    /// `top` (with its alpha) over the opaque `base`.
    static func over(_ top: ThemeColor, _ base: ThemeColor) -> ThemeColor {
        let a = top.alpha
        return rgb(top.red * a + base.red * (1 - a), top.green * a + base.green * (1 - a), top.blue * a + base.blue * (1 - a))
    }

    /// WCAG relative luminance of an opaque colour.
    static func luminance(_ c: ThemeColor) -> Double {
        func ch(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * ch(c.red) + 0.7152 * ch(c.green) + 0.0722 * ch(c.blue)
    }

    /// WCAG contrast ratio of two opaque colours.
    static func contrast(_ a: ThemeColor, _ b: ThemeColor) -> Double {
        let (l1, l2) = (luminance(a), luminance(b))
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> ThemeColor {
        func byte(_ v: Double) -> UInt32 { UInt32(max(0, min(255, (v * 255).rounded()))) }
        return ThemeColor(byte(r) << 16 | byte(g) << 8 | byte(b))
    }
}
