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
            for i in 0..<SplashTimeline.cardCount { XCTAssertEqual(tl.cardOpacity(i, 0), 0, "card \(i)") }
        }
    }

    /// Never slower than the old splash (1.5 s + a 0.4 s fade), everything in place by the
    /// hand-off, and Reduce Motion is only fades (the cards never move) and quicker.
    func testSplashTiming() {
        let full = SplashTimeline(reduceMotion: false), reduced = SplashTimeline(reduceMotion: true)
        XCTAssertLessThanOrEqual(full.total, 1.9)
        XCTAssertLessThan(reduced.total, full.total)
        for tl in [full, reduced] {
            XCTAssertEqual(tl.lamp(tl.finish), 1)
            XCTAssertEqual(tl.logo(tl.finish), 1)
            for i in 0..<SplashTimeline.cardCount {
                XCTAssertEqual(tl.card(i, tl.finish), 1)
                XCTAssertEqual(tl.cardOpacity(i, tl.finish), 1)
            }
        }
        let lastCard = SplashTimeline.dealStart + Double(SplashTimeline.cardCount - 1) * SplashTimeline.dealStagger + SplashTimeline.dealFlight
        XCTAssertLessThan(lastCard, SplashTimeline.finish)
        XCTAssertLessThan(SplashTimeline.logoStart + SplashTimeline.logoDuration, SplashTimeline.finish)
        for t in stride(from: 0.0, through: reduced.finish, by: 0.05) {
            for i in 0..<SplashTimeline.cardCount { XCTAssertEqual(reduced.card(i, t), 1, "Reduce Motion moved a card") }
        }
        // the deal is staggered: the first card is down before the last one leaves
        XCTAssertGreaterThan(full.card(0, 0.4), full.card(3, 0.4))
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
