import XCTest
import SwiftUI
@testable import BAB_Online

/// Item 29: Generated/Theme.swift is what client/tokens/tokens.json says (npm run tokens),
/// and every text-on-surface pair of tokens.json reaches WCAG AA with the Swift values.
/// (tokens:check and the web's tokens.test.js check the same file from Node.)
final class ThemeTests: XCTestCase {
    /// tokens.json from the repo (the simulator reads the host's file system).
    private func tokens() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("client/tokens/tokens.json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func hex(_ s: String) -> ThemeColor {
        var h = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        let rgb = UInt32(h.prefix(6), radix: 16) ?? 0
        let alpha = h.count == 8 ? (Double(Int(h.suffix(2), radix: 16) ?? 255) / 255 * 1000).rounded() / 1000 : 1
        return ThemeColor(rgb, alpha: alpha)
    }

    private func flatten(_ node: Any, _ path: [String], into out: inout [String: String]) {
        if let s = node as? String { out[path.joined(separator: ".")] = s; return }
        for (k, v) in node as? [String: Any] ?? [:] { flatten(v, path + [k], into: &out) }
    }

    func testEveryColorTokenIsGenerated() throws {
        var colors: [String: String] = [:]
        flatten(try tokens()["color"] as Any, [], into: &colors)
        XCTAssertGreaterThan(colors.count, 40)
        XCTAssertEqual(Set(Theme.colorsByPath.keys), Set(colors.keys), "Theme.swift is stale: run npm run tokens")
        for (path, value) in colors {
            XCTAssertEqual(Theme.colorsByPath[path], hex(value), path)
        }
        // the typed tree is the same table
        XCTAssertEqual(Theme.Palette.Surface.s0, Theme.colorsByPath["surface.s0"])
        XCTAssertEqual(Theme.Palette.Felt.base, Theme.colorsByPath["felt.base"])
        XCTAssertEqual(Theme.Palette.Text.onPrimary, Theme.colorsByPath["text.onPrimary"])
        XCTAssertEqual(Theme.Palette.Card.red, Theme.colorsByPath["card.red"])
        XCTAssertEqual(Theme.Palette.scrim.alpha, 0.722, accuracy: 0.0005)
        XCTAssertEqual(Theme.Palette.Surface.s0, ThemeColor(0x0c1411))
    }

    func testScalesMatchTokens() throws {
        let t = try tokens()
        let type = try XCTUnwrap(t["type"] as? [String: Double])
        XCTAssertEqual(Theme.TypeScale.xs, CGFloat(type["xs"]!))
        XCTAssertEqual(Theme.TypeScale.display, CGFloat(type["display"]!))
        XCTAssertEqual([Theme.TypeScale.xs, Theme.TypeScale.sm, Theme.TypeScale.md, Theme.TypeScale.lg,
                        Theme.TypeScale.xl, Theme.TypeScale.xxl, Theme.TypeScale.display], [12, 14, 16, 20, 24, 32, 48])
        let space = try XCTUnwrap(t["space"] as? [String: Double])
        XCTAssertEqual(Theme.Space.s4, CGFloat(space["s4"]!))
        for v in [Theme.Space.s1, Theme.Space.s2, Theme.Space.s3, Theme.Space.s4, Theme.Space.s6, Theme.Space.s12] {
            XCTAssertEqual(v.truncatingRemainder(dividingBy: 4), 0, "a 4 pt grid")
        }
        let radius = try XCTUnwrap(t["radius"] as? [String: Double])
        XCTAssertEqual(Theme.Radius.md, CGFloat(radius["md"]!))
        XCTAssertEqual(Theme.hitTarget, 44)
        XCTAssertEqual(Theme.Motion.fast, 0.12, accuracy: 1e-9)
        XCTAssertEqual(Theme.Motion.dealStagger, 0.035, accuracy: 1e-9)
        XCTAssertEqual(Theme.Motion.emphasized, [0.2, 0.8, 0.2, 1])
        XCTAssertEqual(Theme.Weight.semibold, .semibold)
        XCTAssertEqual(Theme.Elevation.e2.first?.blur, 12)
        XCTAssertEqual((t["contrast"] as? [Any])?.count, Theme.contrastPairs.count)
    }

    // MARK: Contrast (WCAG 2.x, the same math as client/tokens/generate.mjs)

    private func resolve(_ ref: String) -> ThemeColor? {
        let parts = ref.split(separator: "@", maxSplits: 1).map(String.init)
        guard let c = Theme.colorsByPath[parts[0]] else { return nil }
        if parts.count == 2, let a = Double(parts[1]) { return c.opacity(a) }
        return c
    }

    private typealias RGB = (r: Double, g: Double, b: Double)

    private func over(_ top: ThemeColor, _ base: RGB) -> RGB {
        (top.red * top.alpha + base.r * (1 - top.alpha),
         top.green * top.alpha + base.g * (1 - top.alpha),
         top.blue * top.alpha + base.b * (1 - top.alpha))
    }

    private func luminance(_ c: RGB) -> Double {
        func ch(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
    }

    private func ratio(fg: ThemeColor, bgStack: [ThemeColor]) -> Double {
        let bottom = bgStack.last!
        var base: RGB = (bottom.red, bottom.green, bottom.blue)
        for c in bgStack.dropLast().reversed() { base = over(c, base) }
        let f = fg.alpha < 1 ? over(fg, base) : (fg.red, fg.green, fg.blue)
        let (l1, l2) = (luminance(f), luminance(base))
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    func testContrastMathMatchesKnownValues() {
        XCTAssertEqual(ratio(fg: ThemeColor(0x000000), bgStack: [ThemeColor(0xffffff)]), 21, accuracy: 1e-6)
        XCTAssertEqual(ratio(fg: ThemeColor(0x777777), bgStack: [ThemeColor(0xffffff)]), 4.48, accuracy: 0.01)
    }

    func testEveryContrastPairPassesAA() {
        XCTAssertGreaterThan(Theme.contrastPairs.count, 40)
        var failing: [String] = []
        for p in Theme.contrastPairs {
            guard let fg = resolve(p.fg) else { failing.append("unknown \(p.fg)"); continue }
            let stack = p.bg.compactMap(resolve)
            XCTAssertEqual(stack.count, p.bg.count, "unknown token in \(p.bg)")
            let r = ratio(fg: fg, bgStack: stack)
            if r + 1e-9 < p.min { failing.append("\(p.fg) on \(p.bg.joined(separator: " over ")): \(r) < \(p.min)") }
            XCTAssertTrue([3, 4.5].contains(p.min))
        }
        XCTAssertEqual(failing, [])
    }

    /// The iOS role pairs (button fills and their text, the HUD) are tokens.json pairs.
    func testRolePairsAreChecked() {
        let pairs = Set(Theme.contrastPairs.map { "\($0.fg) on \($0.bg.joined(separator: ","))" })
        for pair in ["text.onPrimary on primary.base",          // Theme.buttonForeground on buttonBackground
                     "text.dim on surface.s3",                  // disabled button
                     "text.primary on surface.s3",              // secondary button
                     "text.primary on danger.solid",            // danger fill
                     "text.onLight on warning",                 // warning button
                     "text.onLight on text.primary@0.92,felt.base",   // a seat's chat bubble
                     "text.primary on felt.light@0.95,felt.base",     // a spectator's chat bubble
                     "text.secondary on surface.s2@0.86,felt.edge",   // HSI box
                     "text.dim on surface.s0",                  // chat timestamp dividers
                     "medal.bronze on surface.s1"] {
            XCTAssertTrue(pairs.contains(pair), pair)
        }
        XCTAssertEqual(UsernameColor.teamColor(for: 1), Theme.teamA)
        XCTAssertEqual(UsernameColor.teamColor(for: 4), Theme.teamB)
        XCTAssertEqual(Theme.team(2), Theme.teamB)
        XCTAssertEqual(Theme.medal(rank: 3), Theme.medalBronze)
        XCTAssertNil(Theme.medal(rank: 4))
    }

    func testFeltTextureAndSpriteKitFont() {
        let size = GameSKScene.feltTexture.size()
        XCTAssertEqual(size.width, 256)
        // a font SpriteKit can load by name (never the Times fallback), from tokens.json font.ui
        for w in [UIFont.Weight.regular, .medium, .bold] {
            let name = Theme.SK.fontName(w)
            XCTAssertNotNil(UIFont(name: name, size: 14), name)
            XCTAssertFalse(name.hasPrefix("."), name)
        }
        XCTAssertEqual(Theme.SK.fontName(.bold), "HelveticaNeue-Bold")
        XCTAssertEqual(Theme.SK.fontName(.regular), "HelveticaNeue")
        XCTAssertTrue(Theme.fontStack.contains("Helvetica Neue"))
    }
}
