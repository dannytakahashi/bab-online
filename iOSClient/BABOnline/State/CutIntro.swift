import Foundation
import CoreGraphics

/// Cut for a buck's intro (owner 2026-11-25: "in the spirit of the iOS splash", under 3 s): a pure
/// timeline, a function of the time since it started, as `SplashTimeline` is, drawn by
/// CutForABuckView's TimelineView. "Cut for a buck!" scales in, the deck riffles (two halves
/// interleave) and fans out, the avatars slide from the centre into the ring one after another,
/// and the title goes. Reduce Motion: crossfades only (the ring and the deck fade in where they
/// stand, the title fades in and out), 1.2 s. It plays when the cut starts on this screen, or when
/// I arrive with more than 3 s of the gather left (the web's INTRO_MIN_LEFT_MS); else the view
/// renders static.
struct CutIntro: Equatable {
    static let duration: TimeInterval = 2.6
    static let reducedDuration: TimeInterval = 1.2
    /// The gather time left below which an arrival shows no intro.
    static let minGatherLeft: TimeInterval = 3

    let reduceMotion: Bool

    var finish: TimeInterval { reduceMotion ? Self.reducedDuration : Self.duration }

    /// 0...1 over [a, b].
    static func progress(_ t: TimeInterval, _ a: TimeInterval, _ b: TimeInterval) -> CGFloat {
        guard b > a else { return t >= b ? 1 : 0 }
        return CGFloat(min(1, max(0, (t - a) / (b - a))))
    }

    /// The tokens' emphasized feel: a fast start that settles (ease-out cubic with a touch of overshoot).
    static func emphasized(_ p: CGFloat) -> CGFloat {
        let q = 1 - p
        return 1 - q * q * q + 0.06 * sin(p * .pi)
    }

    func titleOpacity(_ t: TimeInterval) -> CGFloat {
        if reduceMotion { return Self.progress(t, 0, 0.3) * (1 - Self.progress(t, 0.85, 1.2)) }
        return Self.progress(t, 0, 0.35) * (1 - Self.progress(t, 1.95, 2.55))
    }

    func titleScale(_ t: TimeInterval) -> CGFloat {
        if reduceMotion { return 1 }
        return 0.6 + 0.4 * Self.emphasized(Self.progress(t, 0, 0.5)) + 0.08 * Self.progress(t, 1.95, 2.55)
    }

    /// The ring's and the deck's opacity (Reduce Motion's crossfade; 1 in the full form).
    func stageOpacity(_ t: TimeInterval) -> CGFloat {
        reduceMotion ? Self.progress(t, 0, 0.45) : min(1, 0.25 + Self.progress(t, 0.15, 0.5))
    }

    /// The deck's riffle: how far the two halves stand apart (0: squared up), back and forth twice.
    func riffle(_ t: TimeInterval) -> CGFloat {
        if reduceMotion { return 0 }
        let p = Self.progress(t, 0.3, 1.0)
        return p <= 0 || p >= 1 ? 0 : abs(sin(p * 2 * .pi))
    }

    /// The fan's spread, 0 (a squared stack) to 1 (the fan).
    func fanSpread(_ t: TimeInterval) -> CGFloat {
        reduceMotion ? 1 : Self.emphasized(Self.progress(t, 1.0, 1.6))
    }

    /// Seat k of n on its way from the centre into the ring (0: at the centre, hidden; 1: home).
    func seat(_ k: Int, of n: Int, at t: TimeInterval) -> CGFloat {
        if reduceMotion { return 1 }
        let stagger = min(0.07, 0.8 / Double(max(1, n)))
        let start = 1.05 + Double(k) * stagger
        return Self.emphasized(Self.progress(t, start, start + 0.5))
    }

    /// Everything is home and the title has gone.
    func isDone(_ t: TimeInterval) -> Bool { t >= finish }
}
