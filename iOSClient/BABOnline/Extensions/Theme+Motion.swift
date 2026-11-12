import SwiftUI
import UIKit

/// Reduce Motion (Settings > Accessibility > Motion; Apple HIG): the motion tokens
/// (Generated/Theme.swift `Theme.Motion`) say how long things move, this says
/// whether they may. Under Reduce Motion the app keeps its fades and swaps the rest:
///
/// - the repeating pulses (the turn ring, the speaking ring, "Tap to Draw") hold
///   still at their lit alpha;
/// - slides (the log drawer, the bid panel, the status toasts) and the splash's
///   rise and zoom become cross-fades.
///
/// The cards' own moves (deal, play to the trick, collect) stay: they are short,
/// one-off and show where a card went, as Apple's own card games keep them.
/// SwiftUI views read `@Environment(\.accessibilityReduceMotion)`; SpriteKit nodes
/// read `Theme.Motion.reduceMotion` when they start an effect (a ring already
/// pulsing keeps going until it is next shown).
extension Theme.Motion {
    /// Tests pin the setting; nil reads the system's.
    static var reduceMotionOverride: Bool?

    /// Is Reduce Motion on?
    static var reduceMotion: Bool { reduceMotionOverride ?? UIAccessibility.isReduceMotionEnabled }

    /// The alpha a pulsing ring holds under Reduce Motion: the pulse's lit end.
    static let steadyGlowAlpha: CGFloat = 0.8
}

extension AnyTransition {
    /// `moving`, or a plain cross-fade under Reduce Motion.
    static func motion(_ moving: AnyTransition, reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : moving
    }
}
