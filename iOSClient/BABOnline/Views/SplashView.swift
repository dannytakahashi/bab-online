import SwiftUI

/// The boot splash (build 13): the lamp comes up over the night card room, a hand of four
/// aces fans out from under it, the logo settles in exactly where the sign-in's logo
/// stands, the hand is gathered up and put away, and the app hands off by fading the
/// splash away over the next screen. It starts on the launch screen's colour
/// (LaunchBackground = surface.s0, the room), so the first frame is the launch screen, and
/// ends on the sign-in without its card and phrase: the same AuthVignette, and the logo on
/// the sign-in logo's own frame (`logoTarget`, measured from the sign-in that ContentView
/// lays out under the splash), so the hand-off only brings the card in. 1.32 s, then a
/// 0.35 s fade (1.67 s in all; the old splash took 1.9 s). Reduce Motion: the lamp and the
/// logo fade in where they end (no hand), and the hand-off comes at 0.9 s. No sound, no
/// haptics. VoiceOver hears one image, "BAB Online".
struct SplashView: View {
    /// The sign-in logo's frame in global coordinates (`AuthLogoFrameKey`); nil while the
    /// screen under the splash has no logo (a restored session's main room).
    var logoTarget: CGRect?
    /// Called once when the splash has finished (never while a fixture holds a frame).
    var onFinished: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var done = false

    var body: some View {
        let timeline = SplashTimeline(reduceMotion: reduceMotion || Self.fixtureReduceMotion)
        GeometryReader { g in
            let layout = SplashLayout(container: g.frame(in: .global), logoTarget: logoTarget)
            ZStack {
                TimelineView(.animation(minimumInterval: nil, paused: done || Self.heldFrame != nil)) { context in
                    // once done, the final frame exactly (the hand-off swaps the screen in under it)
                    let t = Self.heldFrame ?? (done ? timeline.finish : context.date.timeIntervalSince(start))
                    SplashFrame(t: min(max(t, 0), timeline.finish), timeline: timeline, layout: layout)
                }
                // VoiceOver's one element (the cards' letters and the logo inside are not read)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("BAB Online")
                .accessibilityAddTraits(.isImage)
                .accessibilityIdentifier("splash")
                #if DEBUG
                if UIFixture.isActive {
                    SplashLogoProbe(frame: layout.logo.offsetBy(dx: g.frame(in: .global).minX, dy: g.frame(in: .global).minY))
                }
                #endif
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .task {
            guard Self.heldFrame == nil else { return }
            // the clock starts when the splash is on screen, not when the view was made, so a
            // late first frame still shows the deal from its start
            start = Date()
            try? await Task.sleep(for: .seconds(timeline.finish))
            done = true
            onFinished()
        }
    }

    private static var fixtureReduceMotion: Bool {
        #if DEBUG
        return UIFixture.splashReduceMotion
        #else
        return false
        #endif
    }

    /// A fixture's frozen moment (`-uiSplashFrame <seconds>`, DEBUG), else nil.
    private static var heldFrame: TimeInterval? {
        #if DEBUG
        return UIFixture.splashFrame
        #else
        return nil
        #endif
    }
}

/// Where the splash's logo and hand stand on its full-screen canvas (`container`, global):
/// the logo exactly on the sign-in logo's frame when there is one, else (a restored
/// session's main room) at the sign-in's size under the lamp's centre; the hand below it.
struct SplashLayout: Equatable {
    /// The logo's frame in the splash's own coordinates.
    let logo: CGRect
    let size: CGSize

    init(container: CGRect, logoTarget: CGRect?) {
        size = container.size
        if let target = logoTarget, target.width > 1, target.height > 1 {
            logo = target.offsetBy(dx: -container.minX, dy: -container.minY)
        } else {
            let w = AuthLogoImage.width(for: container.size), h = w / AuthLogoImage.aspect
            logo = CGRect(x: (container.width - w) / 2, y: container.height * 0.36 - h / 2, width: w, height: h)
        }
    }

    var cardWidth: CGFloat { logo.width * 0.26 }
    var cardHeight: CGFloat { cardWidth * 435 / 300 }
    /// The fanned hand's centre: under the logo.
    var fanY: CGFloat { logo.maxY + Theme.Space.s6 + cardHeight / 2 }
}

/// The splash's timing as a pure function of the time since it appeared (0...1 progress
/// per element), so a frame is reproducible (tests, the `-uiSplashFrame` screenshots).
struct SplashTimeline {
    let reduceMotion: Bool

    /// The lamp (the vignette) comes up.
    static let lampStart: TimeInterval = 0, lampDuration: TimeInterval = 0.5
    /// The hand fans out of a squared stack under the lamp: one card every 70 ms, each a
    /// 0.46 s flight on the emphasized curve. Its cards are opaque, as real cards, and the
    /// hand is drawn as one layer, so a fade never shows one card through another.
    static let dealStart: TimeInterval = 0.12, dealStagger: TimeInterval = 0.07, dealFlight: TimeInterval = 0.46
    /// The hand (one layer) comes up as the deal starts.
    static let handFadeIn: TimeInterval = 0.16
    /// The logo settles in once the hand is mostly down.
    static let logoStart: TimeInterval = 0.52, logoDuration: TimeInterval = 0.42
    /// The hand is gathered (the fan closes, it drops a little) and put away (one layer
    /// fading) before the hand-off, so only the sign-in's card comes in under the logo.
    static let gatherStart: TimeInterval = 1.02, gatherDuration: TimeInterval = 0.28
    /// The hand-off starts.
    static let finish: TimeInterval = 1.32
    /// Reduce Motion: one fade of the lamp and the logo (no hand), then the hand-off.
    static let reducedFade: TimeInterval = Theme.Motion.slow, reducedFinish: TimeInterval = 0.9
    /// The hand-off (ContentView): the sign-in's card fades in over the swapped-in screen, or another screen fades in under the splash.
    static let handOff: TimeInterval = Theme.Motion.slow
    static let cardCount = 4

    var finish: TimeInterval { reduceMotion ? Self.reducedFinish : Self.finish }
    /// Launch to the next screen fully shown.
    var total: TimeInterval { finish + Self.handOff }

    func lamp(_ t: TimeInterval) -> Double {
        reduceMotion ? fade(t) : Self.easeOut(Self.progress(t, Self.lampStart, Self.lampDuration))
    }

    /// Card `i`'s flight, 0 (in the stack under the lamp) ... 1 (in the fanned hand).
    func card(_ i: Int, _ t: TimeInterval) -> Double {
        reduceMotion ? 1 : Self.emphasized(Self.progress(t, Self.dealStart + Double(i) * Self.dealStagger, Self.dealFlight))
    }

    /// The gathering-up, 0 (fanned) ... 1 (squared).
    func gather(_ t: TimeInterval) -> Double {
        reduceMotion ? 1 : Self.emphasized(Self.progress(t, Self.gatherStart, Self.gatherDuration))
    }

    /// The whole hand's opacity, as one layer: up as the deal starts, away as it is
    /// gathered (gone by `finish`); none under Reduce Motion.
    func handOpacity(_ t: TimeInterval) -> Double {
        guard !reduceMotion else { return 0 }
        let up = Self.easeOut(Self.progress(t, Self.dealStart, Self.handFadeIn))
        let away = Self.progress(t, Self.gatherStart + Self.gatherDuration * 0.25, Self.gatherDuration * 0.75)
        return up * (1 - away * away)
    }

    func logo(_ t: TimeInterval) -> Double {
        reduceMotion ? fade(t) : Self.emphasized(Self.progress(t, Self.logoStart, Self.logoDuration))
    }

    private func fade(_ t: TimeInterval) -> Double { Self.easeOut(Self.progress(t, 0, Self.reducedFade)) }

    static func progress(_ t: TimeInterval, _ start: TimeInterval, _ duration: TimeInterval) -> Double {
        min(1, max(0, (t - start) / duration))
    }

    static func easeOut(_ p: Double) -> Double { 1 - pow(1 - p, 3) }

    /// The tokens' emphasized cubic-bezier (motion.emphasized: 0.2, 0.8, 0.2, 1) at `p`.
    static func emphasized(_ p: Double) -> Double {
        let c = Theme.Motion.emphasized
        return cubicBezier(p, x1: c[0], y1: c[1], x2: c[2], y2: c[3])
    }

    /// CSS cubic-bezier(x1, y1, x2, y2) at time `x` (bisection on x, then y).
    static func cubicBezier(_ x: Double, x1: Double, y1: Double, x2: Double, y2: Double) -> Double {
        guard x > 0 else { return 0 }
        guard x < 1 else { return 1 }
        func bez(_ s: Double, _ a: Double, _ b: Double) -> Double {
            3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s
        }
        var lo = 0.0, hi = 1.0, s = x
        for _ in 0..<40 {
            s = (lo + hi) / 2
            if bez(s, x1, x2) < x { lo = s } else { hi = s }
        }
        return bez(s, y1, y2)
    }
}

/// One frame of the splash at time `t`.
private struct SplashFrame: View {
    let t: TimeInterval
    let timeline: SplashTimeline
    let layout: SplashLayout

    /// The hand: four aces, as the old splash's four suits.
    private static let suits: [Suit] = [.spades, .hearts, .diamonds, .clubs]
    /// Each card's angle in the fan (degrees).
    private static let angles: [Double] = [-24, -8, 8, 24]

    var body: some View {
        let size = layout.size, logoRect = layout.logo
        let lamp = timeline.lamp(t), logo = timeline.logo(t), gather = timeline.gather(t)
        let hand = timeline.handOpacity(t)
        ZStack {
            Theme.Auth.room
            AuthVignette().opacity(lamp)
            if hand > 0 {
                ZStack {
                    ForEach(0..<SplashTimeline.cardCount, id: \.self) { i in
                        let p = timeline.card(i, t)
                        SplashCard(suit: Self.suits[i], width: layout.cardWidth)
                            // the pivot under the hand, as a hand is held; the fan closes as it is gathered
                            .rotationEffect(.degrees(Self.angles[i] * p * (1 - gather)), anchor: UnitPoint(x: 0.5, y: 2.3))
                            .scaleEffect((0.55 + 0.45 * p) * (1 - 0.08 * gather))
                            .position(x: size.width / 2,
                                      y: logoRect.midY + (layout.fanY - logoRect.midY) * p + Theme.Space.s4 * gather)
                    }
                }
                .frame(width: size.width, height: size.height)
                // one layer: the opaque cards never show through each other while the hand fades
                .compositingGroup()
                .opacity(hand)
            }
            AuthLogoImage(width: logoRect.width)
                .scaleEffect(timeline.reduceMotion ? 1 : 0.94 + 0.06 * logo)
                .position(x: logoRect.midX, y: logoRect.midY + (timeline.reduceMotion ? 0 : 10 * (1 - logo)))
                .opacity(logo)
        }
        .frame(width: size.width, height: size.height)
    }
}

/// A standard face as the game draws it (CardTextureGenerator.renderStandardCard on its
/// 300 x 435 canvas: radius 24, a 3-unit grey edge, the bold index at (20, 16) with its suit
/// under it, a 100-unit pip in the centre), in SwiftUI so the splash renders nothing into
/// the card cache.
private struct SplashCard: View {
    let suit: Suit
    let width: CGFloat

    var body: some View {
        let u = width / 300, height = width * 435 / 300
        let ink = (suit == .hearts || suit == .diamonds ? Theme.CardInk.red : Theme.CardInk.black).color
        let glyph = Self.glyph(suit)
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 24 * u, style: .continuous)
                .fill(Theme.Auth.cardFace)
                .overlay {
                    RoundedRectangle(cornerRadius: 24 * u, style: .continuous)
                        .strokeBorder(Theme.Auth.cardBorder, lineWidth: max(0.5, 3 * u))
                }
                .shadow(color: Theme.Auth.cardShadow, radius: 4 * u * 3, y: 2 * u * 3)
            VStack(spacing: -2 * u) {
                Text("A").font(.system(size: 40 * u, weight: .bold))
                Text(glyph).font(.system(size: 32 * u))
            }
            .foregroundStyle(ink)
            .padding(.leading, 20 * u)
            .padding(.top, 16 * u)
            Text(glyph)
                .font(.system(size: 100 * u))
                .foregroundStyle(ink)
                .frame(width: width, height: height)
        }
        .frame(width: width, height: height)
    }

    /// The suit as text (U+FE0E: never the emoji form).
    static func glyph(_ suit: Suit) -> String {
        switch suit {
        case .spades: return "\u{2660}\u{FE0E}"
        case .hearts: return "\u{2665}\u{FE0E}"
        case .diamonds: return "\u{2666}\u{FE0E}"
        case .clubs: return "\u{2663}\u{FE0E}"
        case .joker: return "\u{2605}\u{FE0E}"
        }
    }
}
