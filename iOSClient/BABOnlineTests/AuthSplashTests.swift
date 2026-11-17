import XCTest
import UIKit
@testable import BAB_Online

/// Build 13: the boot splash and the web-styled sign-in / register (SplashView.swift,
/// Views/Auth/AuthChrome.swift).
final class AuthSplashTests: XCTestCase {
    /// The phrases by the sign-in's logo are the web's SPLASH_PHRASES (client/src/ui/screens/
    /// SignIn.js, read from the checkout), in the same order.
    func testPhrasesMatchTheWeb() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("client/src/ui/screens/SignIn.js"), encoding: .utf8)
        let web = try Self.phrases(inJS: source)
        XCTAssertGreaterThanOrEqual(web.count, 10, "SPLASH_PHRASES not found in SignIn.js")
        XCTAssertEqual(SplashPhrases.all, web, "update SplashPhrases.all (AuthChrome.swift) to the web's SPLASH_PHRASES")
    }

    /// The parser reads both quote styles and their escapes.
    func testPhraseParser() throws {
        let js = "x = 1;\nexport const SPLASH_PHRASES = [\n  'a!',\n  \"it's\",\n  'don\\'t', // note\n];\nconst y = ['no'];"
        XCTAssertEqual(try Self.phrases(inJS: js), ["a!", "it's", "don't"])
    }

    /// The string literals of `export const SPLASH_PHRASES = [ ... ];`.
    static func phrases(inJS source: String) throws -> [String] {
        let start = try XCTUnwrap(source.range(of: "SPLASH_PHRASES = ["), "no SPLASH_PHRASES array")
        let end = try XCTUnwrap(source.range(of: "];", range: start.upperBound..<source.endIndex))
        let body = source[start.upperBound..<end.lowerBound]
        var out: [String] = [], current = "", quote: Character?, escaped = false
        for ch in body {
            if let q = quote {
                if escaped { current.append(ch); escaped = false } else if ch == "\\" { escaped = true } else if ch == q {
                    out.append(current); current = ""; quote = nil
                } else { current.append(ch) }
            } else if ch == "'" || ch == "\"" {
                quote = ch
            }
        }
        return out
    }

    func testRandomPhraseIsOneOfThem() {
        for _ in 0..<20 { XCTAssertTrue(SplashPhrases.all.contains(SplashPhrases.random())) }
    }

    /// The launch screen is the splash's first frame: the room (surface.s0) with the lamp off,
    /// no card and no logo, so nothing flashes when SwiftUI takes over.
    func testLaunchScreenIsTheSplashsFirstFrame() throws {
        let launch = try XCTUnwrap(UIColor(named: "LaunchBackground"))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(launch.getRed(&r, green: &g, blue: &b, alpha: &a))
        let room = Theme.Palette.Surface.s0
        XCTAssertEqual(Double(r), room.red, accuracy: 0.5 / 255)
        XCTAssertEqual(Double(g), room.green, accuracy: 0.5 / 255)
        XCTAssertEqual(Double(b), room.blue, accuracy: 0.5 / 255)
        XCTAssertEqual(a, 1)
        for reduceMotion in [false, true] {
            let tl = SplashTimeline(reduceMotion: reduceMotion)
            XCTAssertEqual(tl.lamp(0), 0)
            XCTAssertEqual(tl.logo(0), 0)
            XCTAssertEqual(tl.handOpacity(0), 0)
        }
    }

    /// Never slower than the old splash (1.5 s + a 0.4 s fade), the lamp and the logo in
    /// place by the hand-off and the hand put away, and Reduce Motion is only fades (no hand)
    /// and quicker.
    func testSplashTiming() {
        let full = SplashTimeline(reduceMotion: false), reduced = SplashTimeline(reduceMotion: true)
        XCTAssertLessThanOrEqual(full.total, 1.9)
        XCTAssertLessThan(reduced.total, full.total)
        for tl in [full, reduced] {
            XCTAssertEqual(tl.lamp(tl.finish), 1)
            XCTAssertEqual(tl.logo(tl.finish), 1)
            // the hand never cross-fades over the sign-in's form
            XCTAssertEqual(tl.handOpacity(tl.finish), 0, "the hand is gone by the hand-off")
        }
        let lastCard = SplashTimeline.dealStart + Double(SplashTimeline.cardCount - 1) * SplashTimeline.dealStagger + SplashTimeline.dealFlight
        XCTAssertLessThan(lastCard, SplashTimeline.gatherStart, "the hand is down before it is gathered")
        XCTAssertLessThanOrEqual(SplashTimeline.gatherStart + SplashTimeline.gatherDuration, SplashTimeline.finish)
        XCTAssertLessThan(SplashTimeline.logoStart + SplashTimeline.logoDuration, SplashTimeline.finish)
        // the whole hand is up between the deal and the gathering
        XCTAssertEqual(full.handOpacity(lastCard), 1)
        XCTAssertEqual(full.gather(lastCard), 0)
        XCTAssertEqual(full.gather(full.finish), 1)
        for t in stride(from: 0.0, through: reduced.finish, by: 0.05) {
            XCTAssertEqual(reduced.handOpacity(t), 0, "Reduce Motion shows no hand")
            for i in 0..<SplashTimeline.cardCount { XCTAssertEqual(reduced.card(i, t), 1, "Reduce Motion moved a card") }
        }
        // the deal is staggered: the first card is down before the last one leaves
        XCTAssertGreaterThan(full.card(0, 0.4), full.card(3, 0.4))
    }

    /// The splash's logo stands exactly on the sign-in logo's frame (global, as measured under
    /// the splash), whatever the splash's own origin; without one, at the sign-in's size.
    func testSplashLogoIsTheSignInsLogo() {
        let target = CGRect(x: 52.5, y: 118.25, width: 270, height: 270 / AuthLogoImage.aspect)
        let full = SplashLayout(container: CGRect(x: 0, y: 0, width: 375, height: 667), logoTarget: target)
        XCTAssertEqual(full.logo, target)
        // a canvas whose origin is not the window's (an iPad window, a Duo pose)
        let offset = SplashLayout(container: CGRect(x: 10, y: -20, width: 375, height: 667), logoTarget: target)
        XCTAssertEqual(offset.logo, target.offsetBy(dx: -10, dy: 20))
        XCTAssertGreaterThan(full.fanY - full.cardHeight / 2, target.maxY, "the hand is below the logo")
        let none = SplashLayout(container: CGRect(x: 0, y: 0, width: 375, height: 667), logoTarget: nil)
        XCTAssertEqual(none.logo.width, AuthLogoImage.width(for: CGSize(width: 375, height: 667)), accuracy: 0.01)
        XCTAssertEqual(none.logo.midX, 187.5, accuracy: 0.01)
        XCTAssertEqual(SplashLayout(container: CGRect(x: 0, y: 0, width: 375, height: 667), logoTarget: .zero).logo, none.logo)
    }

    /// Only the auth screens are laid out under the splash (the main room joins it on
    /// appearing, a game starts voice: they still come in at the hand-off).
    func testScreensUnderTheSplash() {
        XCTAssertTrue(ContentView.drawsUnderSplash(.signIn))
        XCTAssertTrue(ContentView.drawsUnderSplash(.register))
        for screen in [AppState.Screen.mainRoom, .gameLobby, .tournamentLobby, .game] {
            XCTAssertFalse(ContentView.drawsUnderSplash(screen), "\(screen)")
        }
    }

    /// The emphasized curve: CSS cubic-bezier(0.2, 0.8, 0.2, 1), monotonic, fast out of the gate.
    func testEmphasizedCurve() {
        XCTAssertEqual(SplashTimeline.emphasized(0), 0)
        XCTAssertEqual(SplashTimeline.emphasized(1), 1)
        XCTAssertGreaterThan(SplashTimeline.emphasized(0.3), 0.75)
        var last = 0.0
        for p in stride(from: 0.0, through: 1.0, by: 0.01) {
            let y = SplashTimeline.emphasized(p)
            XCTAssertGreaterThanOrEqual(y + 1e-9, last)
            last = y
        }
        // linear when the control points sit on the diagonal
        XCTAssertEqual(SplashTimeline.cubicBezier(0.37, x1: 1.0 / 3, y1: 1.0 / 3, x2: 2.0 / 3, y2: 2.0 / 3), 0.37, accuracy: 1e-6)
    }

    /// The logo keeps the form near on short screens and stays the web's size class elsewhere.
    func testLogoWidth() {
        XCTAssertEqual(AuthLogoImage.width(for: CGSize(width: 375, height: 667)), 270, accuracy: 0.5)   // SE: 72%
        XCTAssertEqual(AuthLogoImage.width(for: CGSize(width: 1032, height: 1376)), 340)              // iPad: capped
        let landscape = AuthLogoImage.width(for: CGSize(width: 874, height: 370))
        XCTAssertLessThanOrEqual(landscape / AuthLogoImage.aspect, 370 * 0.3, "a third of a landscape phone at most")
    }
}
