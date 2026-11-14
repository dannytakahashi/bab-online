import XCTest
import CryptoKit
import UIKit
@testable import BAB_Online

/// The card art of iOS 1.2.1 (owner 2026-11-13): the back is the web's red lattice
/// (cardFaces.js drawBack), the jokers are the web's faithful joker (drawJokerFace) with
/// a system-bold HI / LO index, and every other face is exactly what 1.2.0 drew.
/// Read in canvas units (the 300 x 435 drawing canvas) mapped onto each bitmap.
final class CardArtTests: XCTestCase {

    // MARK: pixels

    /// RGBA (premultiplied, sRGB, 8-bit) of a bitmap, read through one fixed format.
    struct Pixels {
        let w: Int, h: Int
        let bytes: [UInt8]

        init(_ image: UIImage) {
            let cg = image.cgImage!
            w = cg.width
            h = cg.height
            var buf = [UInt8](repeating: 0, count: w * h * 4)
            let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            bytes = buf
        }

        /// The pixel under canvas point (x, y), y down.
        func at(_ x: CGFloat, _ y: CGFloat) -> (r: Int, g: Int, b: Int, a: Int) {
            let px = min(w - 1, max(0, Int(x * CGFloat(w) / 300))), py = min(h - 1, max(0, Int(y * CGFloat(h) / 435)))
            let i = (py * w + px) * 4
            return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]), Int(bytes[i + 3]))
        }

        /// Pixels inside the canvas rect within `tol` of `color` in every channel.
        func count(_ color: ThemeColor, in rect: CGRect = CGRect(x: 0, y: 0, width: 300, height: 435), tol: Int = 24) -> Int {
            let c = CardArtTests.rgb(color)
            let x0 = Int(rect.minX * CGFloat(w) / 300), x1 = Int(rect.maxX * CGFloat(w) / 300)
            let y0 = Int(rect.minY * CGFloat(h) / 435), y1 = Int(rect.maxY * CGFloat(h) / 435)
            var n = 0
            for y in max(0, y0)..<min(h, y1) {
                for x in max(0, x0)..<min(w, x1) {
                    let i = (y * w + x) * 4
                    guard bytes[i + 3] > 250 else { continue }
                    if abs(Int(bytes[i]) - c.0) <= tol && abs(Int(bytes[i + 1]) - c.1) <= tol && abs(Int(bytes[i + 2]) - c.2) <= tol { n += 1 }
                }
            }
            return n
        }

        /// Pixels in the rect whose colour is neither of `allowed` (within `tol`).
        func countOther(than allowed: [ThemeColor], in rect: CGRect, tol: Int = 24) -> Int {
            let cs = allowed.map(CardArtTests.rgb)
            let x0 = Int(rect.minX * CGFloat(w) / 300), x1 = Int(rect.maxX * CGFloat(w) / 300)
            let y0 = Int(rect.minY * CGFloat(h) / 435), y1 = Int(rect.maxY * CGFloat(h) / 435)
            var n = 0
            for y in y0..<y1 {
                for x in x0..<x1 {
                    let i = (y * w + x) * 4
                    let p = (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
                    if !cs.contains(where: { abs(p.0 - $0.0) <= tol && abs(p.1 - $0.1) <= tol && abs(p.2 - $0.2) <= tol }) { n += 1 }
                }
            }
            return n
        }
    }

    static func rgb(_ c: ThemeColor) -> (Int, Int, Int) {
        (Int((c.red * 255).rounded()), Int((c.green * 255).rounded()), Int((c.blue * 255).rounded()))
    }

    private func isClose(_ p: (r: Int, g: Int, b: Int, a: Int), _ c: ThemeColor, tol: Int = 24) -> Bool {
        let q = Self.rgb(c)
        return p.a > 250 && abs(p.r - q.0) <= tol && abs(p.g - q.1) <= tol && abs(p.b - q.2) <= tol
    }

    // MARK: the back

    /// The lattice's cell (cardFaces.js backLattice): 10 half-cells across, 12 down each half of the field.
    private let field: CGFloat = 16 + 15 + 3.5
    private var cellX: CGFloat { (300 - 2 * field) / 10 }
    private var cellY: CGFloat { (435 - 2 * field) / 12 }

    /// The back is the red lattice, not the green four-suit back: a cream card and margin, a
    /// card.backRed panel, a paper trellis across the field and the medallion in the middle;
    /// no green anywhere. At the textures' size and at the draw's sizes (phone, Duo, iPad).
    func testBackIsTheRedLattice() {
        let backs: [(String, UIImage)] = [("texture size", CardTextureGenerator.cardBackImage())]
            + [60, 73, 90, 100].map { w in ("draw \(Int(w)) pt", CardTextureGenerator.renderBackForTesting(pixelSize: CardTextureGenerator.backPixelSize(width: w))) }
        XCTAssertEqual(Theme.CardBack.ink, Theme.Palette.Card.backRed)
        XCTAssertEqual(Theme.CardBack.paper, Theme.Palette.Card.backPaper)
        for (what, image) in backs { assertRedLattice(Pixels(image), what) }
    }

    /// The red lattice (cardFaces.js drawBack): cream edge and margin, a card.backRed band,
    /// the medallion with its paper lozenges, a paper trellis across the field, mostly ink,
    /// none of the old green back or its suit glyphs.
    private func assertRedLattice(_ p: Pixels, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let ink = Theme.CardBack.ink, paper = Theme.CardBack.paper
        // cream card edge and margin, the ink panel's band
        XCTAssertTrue(isClose(p.at(8, 217), paper, tol: 6), "\(what): margin \(p.at(8, 217))", file: file, line: line)
        XCTAssertTrue(isClose(p.at(150, 8), paper, tol: 6), "\(what): margin", file: file, line: line)
        XCTAssertTrue(isClose(p.at(28, 120), ink, tol: 30), "\(what): band \(p.at(28, 120))", file: file, line: line)
        XCTAssertTrue(isClose(p.at(272, 315), ink, tol: 30), "\(what): band", file: file, line: line)
        // the medallion: ink in the middle, a paper lozenge half a cell above and below it
        XCTAssertTrue(isClose(p.at(150, 217.5), ink, tol: 30), "\(what): medallion centre \(p.at(150, 217.5))", file: file, line: line)
        XCTAssertTrue(isClose(p.at(150, 217.5 - cellY / 2), paper, tol: 40), "\(what): medallion lozenge \(p.at(150, 217.5 - cellY / 2))", file: file, line: line)
        XCTAssertTrue(isClose(p.at(150, 217.5 + cellY / 2), paper, tol: 40), "\(what): medallion lozenge", file: file, line: line)
        // the trellis: along a row between crossings, the field alternates ink and paper
        var runs = 0, last: Bool?
        let y = 217.5 - 3 * cellY - cellY / 4
        for x in stride(from: field + 2, through: 300 - field - 2, by: 0.5) {
            let q = p.at(x, y)
            let light = q.r + q.g + q.b > 3 * 200
            if let l = last, l != light { runs += 1 }
            last = light
        }
        XCTAssertGreaterThanOrEqual(runs, 16, "\(what): the trellis crosses a row at least 8 times", file: file, line: line)
        // most of the panel is ink; none of the old back's greens
        let inkShare = Double(p.count(ink, tol: 30)) / Double(p.w * p.h)
        XCTAssertGreaterThan(inkShare, 0.3, "\(what): ink share \(inkShare)", file: file, line: line)
        for green in [Theme.Palette.Card.back, Theme.Palette.Card.backBorder, Theme.Palette.Card.backInner] {
            XCTAssertEqual(p.count(green, tol: 12), 0, "\(what): the old back's green", file: file, line: line)
        }
        XCTAssertEqual(p.count(Theme.Palette.Danger.text, tol: 12), 0, "\(what): the old back's suit glyphs", file: file, line: line)
    }

    /// The draw renders its back at the draw card's own size (1:1, no resampling), and the
    /// lattice keeps the web's small-size rules: the full pattern at the draw's sizes, the
    /// pitch doubling and the single-line trellis only below them.
    func testBackRendersAtTheDrawSizeAndHintsBelowIt() {
        for width in [CGFloat(320), 375, 390, 440, 466, 744, 1032, 1376] {
            let card = DrawMetrics(width: width).card
            let image = CardTextureGenerator.cardBackImage(width: card.width)
            let px = CardTextureGenerator.backPixelSize(width: card.width)
            XCTAssertEqual(CGFloat(image.cgImage!.width), px.width, "\(width)")
            XCTAssertEqual(px.width, (card.width * CardTextureGenerator.displayScale).rounded(.up), "\(width): 1:1 at the screen scale")
            XCTAssertEqual(image.size.width, card.width, accuracy: 1 / CardTextureGenerator.displayScale, "\(width)")
            XCTAssertEqual(image.size.height, card.height, accuracy: 1, "\(width)")
            XCTAssertTrue(image === CardTextureGenerator.cardBackImage(width: card.width), "\(width): cached")
            // the draw's cards are 60 ... 100 pt: the pitch never doubles, and from a 375 pt
            // window up (every phone, the Duo, an iPad full screen) the double line and dots
            // resolve too; only a 320 pt iPad window at 2x (k 0.4) draws the single-line trellis
            let k = px.width / 300
            XCTAssertEqual(CardTextureGenerator.backHint(cellX, k, minPx: 5.5, cap: 4), 1, "\(width): no pitch doubling at k \(k)")
            if width >= 375 { XCTAssertGreaterThanOrEqual(1.2 * k, 0.5, "\(width): the double line and dots resolve at k \(k)") }
            print("[CardArt] draw back at \(Int(width)) pt window: card \(card.width) pt, \(Int(px.width)) px, k \(k)")
        }
        // the web's hint steps, below the draw's sizes (cardFaces.js backHint)
        XCTAssertEqual(CardTextureGenerator.backHint(cellX, 0.2, minPx: 5.5, cap: 4), 2)
        XCTAssertEqual(CardTextureGenerator.backHint(cellX, 0.1, minPx: 5.5, cap: 4), 4)
        XCTAssertEqual(CardTextureGenerator.backHint(cellX, 0.01, minPx: 5.5, cap: 4), 4, "capped")
        // the band's beads: about 9 units apart, both ends of every side, clear of the corners
        let beads = CardTextureGenerator.backBandPoints(25, pitch: 9, cornerGap: 6)
        // across: (250 - 12) / 9 -> 26 gaps; down: (385 - 12) / 9 -> 41 gaps; both ends of each side
        XCTAssertEqual(beads.count, 2 * (26 + 1) + 2 * (41 + 1))
        XCTAssertTrue(beads.allSatisfy { $0.x >= 25 - 0.001 && $0.x <= 275.001 && $0.y >= 25 - 0.001 && $0.y <= 410.001 })
        // the same after a half turn
        let turned = Set(beads.map { "\(Int((300 - $0.x) * 10)),\(Int((435 - $0.y) * 10))" })
        XCTAssertEqual(Set(beads.map { "\(Int($0.x * 10)),\(Int($0.y * 10))" }), turned)
        // tiny sizes still render the back (one bold medallion diamond, no crash)
        let tiny = Pixels(CardTextureGenerator.renderBackForTesting(pixelSize: CGSize(width: 30, height: 44)))
        XCTAssertTrue(isClose(tiny.at(150, 217.5), Theme.CardBack.paper, tol: 60), "the small medallion is one paper diamond: \(tiny.at(150, 217.5))")
    }

    /// The unused SpriteKit back (cardBackTexture / CardSpriteNode.cardBack) draws the same lattice.
    func testBackTextureIsTheLatticeToo() {
        let tex = CardTextureGenerator.cardBackTexture()
        let p = Pixels(UIImage(cgImage: tex.cgImage()))
        XCTAssertEqual(CGFloat(p.w), CardTextureGenerator.pixelSize().width)
        assertRedLattice(p, "SpriteKit texture")
    }

    // MARK: the jokers

    /// The jokers are the web's: a slate outline, a light-blue panel with the black dollar,
    /// HI in card red / LO in card black in the top-left corner, nothing at the bottom right,
    /// and none of the old purple star, JOKER word or labels.
    func testJokersAreTheWebsFaithfulJoker() {
        let red = Theme.CardInk.red, black = Theme.CardInk.black
        for hi in [true, false] {
            let card = Card(suit: .joker, rank: hi ? .hi : .lo)
            let p = Pixels(CardTextureGenerator.renderFaceForTesting(card))
            let tag = hi ? "HI" : "LO"
            // no purple anywhere: the star, "JOKER" and the old labels are gone
            XCTAssertEqual(p.count(Theme.CardInk.joker, tol: 40), 0, "\(tag): purple")
            // the slate outline, the light-blue inner border and panel
            XCTAssertTrue(isClose(p.at(2, 217), Theme.JokerInk.outline, tol: 16), "\(tag): outline \(p.at(2, 217))")
            XCTAssertTrue(isClose(p.at(25, 217), Theme.JokerInk.frame, tol: 16), "\(tag): inner border \(p.at(25, 217))")
            XCTAssertTrue(isClose(p.at(90, 217), Theme.JokerInk.frame, tol: 8), "\(tag): panel \(p.at(90, 217))")
            // the dollar: black strokes in the panel's middle
            XCTAssertGreaterThan(p.count(Theme.JokerInk.glyph, in: CGRect(x: 115, y: 150, width: 70, height: 145), tol: 40), 100, "\(tag): dollar")
            // the word: in its corner box, in its colour only
            let box = CardTextureGenerator.jokerWordInk(tag).ink
            XCTAssertGreaterThan(p.count(hi ? red : black, in: box, tol: 40), 60, "\(tag): the corner word's colour")
            XCTAssertEqual(p.count(hi ? black : red, in: box, tol: 40), 0, "\(tag): not the other colour")
            // the word's patch cuts the inner border (white where the border would pass behind it)
            XCTAssertTrue(isClose(p.at(box.maxX + 3, 25), Theme.Palette.Card.face, tol: 6), "\(tag): patch \(p.at(box.maxX + 3, 25))")
            // nothing at the bottom right: between the panel and the inner border it is all face
            let corner = CGRect(x: 200, y: 340, width: 68, height: 63)
            XCTAssertEqual(p.countOther(than: [Theme.Palette.Card.face], in: corner, tol: 6), 0, "\(tag): a bottom-right symbol")
            // no top-right label either
            let topRight = CGRect(x: 180, y: 32, width: 88, height: 60)
            XCTAssertEqual(p.countOther(than: [Theme.Palette.Card.face], in: topRight, tol: 6), 0, "\(tag): a top-right label")
            // red only in the HI word, nowhere else on either joker
            XCTAssertEqual(p.count(red, tol: 40) - p.count(red, in: box.insetBy(dx: -2, dy: -2), tol: 40), 0, "\(tag): red outside the word")
        }
    }

    /// The word is the rank index in the system bold: its cap top where a rank's is, never
    /// further right than the widest rank ("10"), at the rank's size unless "LO" would pass it.
    func testJokerWordIsSizedLikeTheRankIndex() {
        let rank = UIFont.systemFont(ofSize: CardTextureGenerator.indexFontSize, weight: .bold)
        let font = CardTextureGenerator.jokerWordFont
        XCTAssertEqual(font.fontName, rank.fontName, "the system bold, no bundled font")
        XCTAssertLessThanOrEqual(font.pointSize, CardTextureGenerator.indexFontSize)
        XCTAssertGreaterThan(font.pointSize, 0.85 * CardTextureGenerator.indexFontSize, "about the rank's size")
        let tenRight = CardTextureGenerator.indexOrigin.x + CardTextureGenerator.inkBounds("10", rank).maxX
        let capTop = CardTextureGenerator.indexOrigin.y + rank.ascender - rank.capHeight
        for word in ["HI", "LO"] {
            let ink = CardTextureGenerator.jokerWordInk(word).ink
            XCTAssertLessThanOrEqual(ink.maxX, tenRight + 0.1, "\(word) ends where a 10 ends, or before (glyph bounds scale a hair off linear)")
            XCTAssertEqual(ink.minY, capTop, accuracy: 1.2, "\(word): a rank's cap top")
            XCTAssertGreaterThan(ink.minX, 12, "\(word): clear of the slate outline (6 units)")
        }
        let lo = CardTextureGenerator.jokerWordInk("LO").ink
        XCTAssertEqual(lo.maxX, tenRight, accuracy: 0.5, "LO is the wider word: it sets the size")
        print("[CardArt] joker word \(font.pointSize) (rank \(rank.pointSize)); right edge \(lo.maxX), the 10's \(tenRight)")
    }

    /// The hand's tightest strip: a hand card shows `handOverlap / handScale` local units of
    /// its left edge (a card is 100 local units, the canvas 300), the same at every zoom (the
    /// camera scales the whole hand). The joker word fits wherever a 10 fits: on every listed
    /// device's 13-card hand all of it, but for at most half a canvas unit (a sixth of a point,
    /// the glyphs' anti-aliased edge; the tightest, the Duo's book pose at 63.9 units, cuts the
    /// 10 by as much).
    func testJokerWordShowsInTheTightestHandStrip() {
        let rank = UIFont.systemFont(ofSize: CardTextureGenerator.indexFontSize, weight: .bold)
        let tenRight = CardTextureGenerator.indexOrigin.x + CardTextureGenerator.inkBounds("10", rank).maxX
        let jokerRight = max(CardTextureGenerator.jokerWordInk("HI").ink.maxX, CardTextureGenerator.jokerWordInk("LO").ink.maxX)
        let edge: CGFloat = 0.5
        var tightest = CGFloat.infinity, tightestAt = ""
        for (size, ins) in TableLayoutTests.listedSizes {
            for topBar in [CGFloat(70), 84] {
                let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar))
                guard !L.isDegraded else { continue }
                let strip = L.handOverlap(count: 13) / L.handScale * 3
                if strip < tightest { tightest = strip; tightestAt = "\(size) \(ins) topBar \(topBar) s \(L.handScale) zoom \(L.zoom)" }
                XCTAssertGreaterThanOrEqual(strip, jokerRight - edge, "\(size) \(ins): the joker's corner shows in a 13-card hand")
            }
        }
        // the measured closed Duo (ui.pose, raised seats) and the iPad at zoom 1.4
        let duo = TableLayout(size: CGSize(width: 466, height: 678),
                              chrome: TableLayoutTests.chrome(TableLayoutTests.insets(0, 0, 34, 84), topBar: 75.333, corner: CGSize(width: 79.667, height: 50.333)))
        XCTAssertGreaterThanOrEqual(duo.handOverlap(count: 13) / duo.handScale * 3, jokerRight)
        let ipad = TableLayout(size: CGSize(width: 1032, height: 1376), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0)))
        XCTAssertGreaterThan(ipad.zoom, 1)
        XCTAssertGreaterThanOrEqual(ipad.handOverlap(count: 13) / ipad.handScale * 3, jokerRight)
        XCTAssertLessThanOrEqual(jokerRight, tenRight + 0.1)
        print("[CardArt] tightest 13-card strip \(tightest) canvas units at \(tightestAt); joker word right edge \(jokerRight), the 10's \(tenRight); "
              + "Duo closed \(duo.handOverlap(count: 13) / duo.handScale * 3), iPad 13 \(ipad.handOverlap(count: 13) / ipad.handScale * 3) (zoom \(ipad.zoom))")
    }

    // MARK: every other face

    /// Every non-joker face is the 1.2.0 one, pixel for pixel: a SHA-256 of the 52 faces'
    /// RGBA on the iOS 27.2 simulator for the two texture configurations (a 3x phone at zoom
    /// 1, a 2x iPad at the table's zoom 1.4), the faces of 1.2.0 / origin/main efccbcb (recorded
    /// with this change, whose 52 faces were byte-identical to efccbcb's in PNG dumps on both).
    /// Another runtime (fonts) or configuration skips rather than guesses.
    func testStandardFacesAreUnchanged() throws {
        let golden: [String: String] = [
            "3x-z1.0": "f4a4a1fa400527fb919fd272bd313f08ffc6ce585d11a0cdd315a17dc896bc33",
            "2x-z1.4": "02f917499b06c82b853080f8d4d311e8e7c5b91a953d89ddda6ec6df3a18bea7",
        ]
        let key = String(format: "%.0fx-z%.1f", CardTextureGenerator.displayScale, CardTextureGenerator.textureZoom)
        let digest = Self.standardFacesDigest()
        print("[CardArt] standard faces \(key) on iOS \(UIDevice.current.systemVersion): \(digest)")
        guard UIDevice.current.systemVersion == "27.2" else { throw XCTSkip("recorded on iOS 27.2, this is \(UIDevice.current.systemVersion)") }
        let want = try XCTUnwrap(golden[key], "no recording for \(key)")
        XCTAssertEqual(digest, want, "a standard face changed (\(key))")
    }

    static func standardFacesDigest() -> String {
        var hasher = SHA256()
        for card in CardTextureGenerator.allCards where !card.isJoker {
            let p = Pixels(CardTextureGenerator.renderFaceForTesting(card))
            hasher.update(data: Data(card.id.utf8))
            hasher.update(data: Data([UInt8(truncatingIfNeeded: p.w), UInt8(truncatingIfNeeded: p.h)]))
            hasher.update(data: Data(p.bytes))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
