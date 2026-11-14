#!/usr/bin/env swift
// The BAB Online app icon (1.2.0 build 8): a fanned hand on the felt, a black
// spade in front of a red heart and the HI joker (the web's joker face).
// Writes the three appearances of AppIcon.appiconset:
//   icon_1024.png         any / light: opaque, no alpha (App Store requirement)
//   icon_1024_dark.png    dark: the cards on a transparent background
//   icon_1024_tinted.png  tinted: grayscale on black (iOS colourises it)
// Run from the repo root: swift iOSClient/generate_icon.swift
// then npm run build:icons for the web favicon, touch icon and phone gate art.
//
// Palette from client/tokens/tokens.json (felt greens, card red/black/joker);
// suit shapes are the SUIT_PATHS of client/src/phaser/cards/cardFaces.js
// (100 x 100 box, y down); the joker is its drawJokerFace (JOKER_INK, the
// sprite-pixel panel, flourishes and dollar, the word in the card index font
// client/assets/fonts/BABCardIndex.woff2), laid out for the fan (drawJoker).

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outDir = "iOSClient/BABOnline/Resources/Assets.xcassets/AppIcon.appiconset"
let S: CGFloat = 1024
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func hex(_ s: String, _ a: CGFloat = 1) -> CGColor {
    var v: UInt64 = 0
    Scanner(string: s.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
    return CGColor(colorSpace: srgb, components: [
        CGFloat((v >> 16) & 0xff) / 255, CGFloat((v >> 8) & 0xff) / 255, CGFloat(v & 0xff) / 255, a,
    ])!
}
func gray(_ g: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: srgb, components: [g, g, g, a])!
}

// MARK: - tokens
let feltEdge = hex("#071d15"), feltDeep = hex("#0b2e22"), feltBase = hex("#0f3d2e")
let feltLight = hex("#145a41"), feltRim = hex("#1f6e51")
let cardRed = hex("#d91a1a"), cardBlack = hex("#1a1a1a")
// cardFaces.js JOKER_INK
let jokerOutline = hex("#4d5766"), jokerFrame = hex("#c7d7ec"), jokerFlourish = hex("#ffffff"), jokerGlyph = hex("#000000")
let cream = hex("#fdfbf5"), creamShade = hex("#ebe4d4"), cardBorder = hex("#c9c1b0")

// MARK: - context helpers
func makeCtx(_ w: Int, _ h: Int, opaque: Bool) -> CGContext {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let c = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: srgb, bitmapInfo: info)!
    c.interpolationQuality = .high
    c.setShouldAntialias(true)
    // y-down, like the card design code
    c.translateBy(x: 0, y: CGFloat(h))
    c.scaleBy(x: 1, y: -1)
    return c
}
func save(_ img: CGImage, _ name: String) {
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil)
    precondition(CGImageDestinationFinalize(d), "write \(name)")
}

// MARK: - suit shapes (cardFaces.js SUIT_PATHS, 100-unit box, y down)
func suitPath(_ suit: String) -> CGPath {
    let p = CGMutablePath()
    func c(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat, _ y: CGFloat) {
        p.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
    }
    switch suit {
    case "hearts":
        p.move(to: CGPoint(x: 50, y: 96))
        c(22, 74, 2, 56, 2, 32); c(2, 15, 14, 4, 28, 4); c(39, 4, 46, 11, 50, 21)
        c(54, 11, 61, 4, 72, 4); c(86, 4, 98, 15, 98, 32); c(98, 56, 78, 74, 50, 96)
        p.closeSubpath()
        return p
    case "diamonds":
        p.move(to: CGPoint(x: 50, y: 2))
        c(62, 20, 74, 36, 86, 50); c(74, 64, 62, 80, 50, 98); c(38, 80, 26, 64, 14, 50); c(26, 36, 38, 20, 50, 2)
        p.closeSubpath()
        return p
    case "spades":
        p.move(to: CGPoint(x: 50, y: 2))
        c(64, 20, 98, 38, 98, 62); c(98, 77, 87, 86, 75, 86); c(65, 86, 58, 81, 54, 74)
        c(55, 84, 60, 92, 68, 98)
        p.addLine(to: CGPoint(x: 32, y: 98))
        c(40, 92, 45, 84, 46, 74); c(42, 81, 35, 86, 25, 86); c(13, 86, 2, 77, 2, 62); c(2, 38, 36, 20, 50, 2)
        p.closeSubpath()
        return p
    case "clubs":
        var u: CGPath = CGPath(ellipseIn: CGRect(x: 28, y: 3, width: 44, height: 44), transform: nil)
        for (cx, cy, r) in [(26.0, 58.0, 22.0), (74.0, 58.0, 22.0), (50.0, 52.0, 14.0)] as [(CGFloat, CGFloat, CGFloat)] {
            u = u.union(CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: nil))
        }
        let stem = CGMutablePath()
        stem.move(to: CGPoint(x: 46, y: 60))
        stem.addCurve(to: CGPoint(x: 32, y: 98), control1: CGPoint(x: 46, y: 78), control2: CGPoint(x: 41, y: 90))
        stem.addLine(to: CGPoint(x: 68, y: 98))
        stem.addCurve(to: CGPoint(x: 54, y: 60), control1: CGPoint(x: 59, y: 90), control2: CGPoint(x: 54, y: 78))
        stem.closeSubpath()
        return u.union(stem)
    default:
        fatalError("no suit \(suit)")
    }
}

func fillSuit(_ ctx: CGContext, _ suit: String, _ cx: CGFloat, _ cy: CGFloat, _ size: CGFloat, _ color: CGColor) {
    let k = size / 100
    ctx.saveGState()
    ctx.translateBy(x: cx - 50 * k, y: cy - 50 * k)
    ctx.scaleBy(x: k, y: k)
    ctx.addPath(suitPath(suit))
    ctx.setFillColor(color)
    ctx.fillPath()
    ctx.restoreGState()
}


// MARK: - the joker (cardFaces.js drawJokerFace)
// The card index font (the web cards' "BAB Card Index", Arvo Bold subset).
let cardFont: CTFont = {
    let url = URL(fileURLWithPath: "client/assets/fonts/BABCardIndex.woff2")
    guard let data = try? Data(contentsOf: url),
          let d = (CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor])?.first
    else { fatalError("run from the repo root: no client/assets/fonts/BABCardIndex.woff2") }
    return CTFontCreateWithFontDescriptor(d, 100, nil)
}()

/// `str` in the card font as one path, y down, baseline at y = 0.
func wordPath(_ str: String) -> CGPath {
    let attr = NSAttributedString(string: str, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): cardFont])
    let out = CGMutablePath()
    for run in CTLineGetGlyphRuns(CTLineCreateWithAttributedString(attr)) as! [CTRun] {
        let n = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: n)
        var pos = [CGPoint](repeating: .zero, count: n)
        CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: n), &pos)
        for i in 0..<n {
            var t = CGAffineTransform(translationX: pos[i].x, y: 0).scaledBy(x: 1, y: -1)
            if let g = CTFontCreatePathForGlyph(cardFont, glyphs[i], &t) { out.addPath(g) }
        }
    }
    return out
}

/// The sprite's boxy dollar (jokerDollar), in sprite pixels: the S, the two
/// bars with the loop that joins them under it, the top serifs (open strokes).
let dollarPath: CGPath = {
    let p = CGMutablePath()
    func M(_ x: CGFloat, _ y: CGFloat) { p.move(to: CGPoint(x: x, y: y)) }
    func L(_ x: CGFloat, _ y: CGFloat) { p.addLine(to: CGPoint(x: x, y: y)) }
    func B(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat, _ e: CGFloat, _ f: CGFloat) {
        p.addCurve(to: CGPoint(x: e, y: f), control1: CGPoint(x: a, y: b), control2: CGPoint(x: c, y: d))
    }
    M(36.5, 28.9); L(36.5, 27.2); B(36.5, 26.1, 35.7, 25.5, 34.6, 25.5); L(29.1, 25.5)
    B(28.0, 25.5, 27.5, 26.2, 27.5, 27.3); L(27.5, 30.6); B(27.5, 31.5, 28.3, 31.9, 29.2, 32.2)
    L(34.3, 34.2); B(35.7, 34.7, 36.5, 35.5, 36.5, 36.7); L(36.5, 38.0); B(36.5, 39.0, 35.8, 39.5, 34.8, 39.5)
    L(28.9, 39.5); B(28.0, 39.5, 27.5, 38.9, 27.5, 38.0); L(27.5, 36.6)
    M(29.5, 23.5); L(29.5, 39.6); B(29.5, 41.9, 34.5, 41.9, 34.5, 39.6); L(34.5, 23.5)
    M(27.9, 23.5); L(31.1, 23.5)
    M(32.9, 23.5); L(36.1, 23.5)
    return p
}()

struct JokerInk {
    var outline: CGColor     // the slate edge
    var frame: CGColor       // the inner border and the centre panel
    var flourish: CGColor
    var glyph: CGColor       // the dollar
    var word: CGColor        // HI (card red)
}

// The joker's layout, card-local units (origin the card centre, y down); the
// web's 300 x 435 design units are k = cardW / 300 of them. Two changes for
// the fan: the front card hides this card's left half, so the word takes the
// top-RIGHT corner (the web's top-left index, mirrored to the corner that
// shows) and the panel sits in the strip that shows under it; and every
// line is thicker than the web's so the face still reads at 40-60 px.
enum JK {
    static let k = cardW / 300
    static let outlineW = 10 * k          // visible slate (web: 6)
    static let frameInset = 25 * k, frameW = 11 * k, frameR = 7 * k   // web: 25, 6.5, 7
    static let wordCap = 70 * k           // HI cap height (web: the ranks' 70)
    static let wordTop = 24 * k, wordSide = 20 * k, wordCol = 50 * k, wordPad = 6 * k
    static let panelW: CGFloat = 96       // the sprite panel's 22 px wide (aspect kept)
    static let panelCentre = CGPoint(x: 100, y: -76)
    static let dollarScale: CGFloat = 1.4 // the dollar inside the panel (web: 1)
    static let dollarW: CGFloat = 1.75    // its stroke, sprite px (web: 1)
}

/// Under the dim: the inner border, and the white patch the word sits on.
func jokerUnder(_ ctx: CGContext, _ st: Style, word: CGRect) {
    let inset = CGRect(x: -cardW / 2, y: -cardH / 2, width: cardW, height: cardH).insetBy(dx: JK.frameInset, dy: JK.frameInset)
    ctx.addPath(CGPath(roundedRect: inset, cornerWidth: JK.frameR, cornerHeight: JK.frameR, transform: nil))
    ctx.setStrokeColor(st.joker.frame); ctx.setLineWidth(JK.frameW); ctx.strokePath()
    ctx.setFillColor(st.face)
    ctx.fill(word.insetBy(dx: -JK.wordPad, dy: -JK.wordPad))
}

/// The word's path placed on the card, and its ink box.
func jokerWord() -> (CGPath, CGRect) {
    let raw = wordPath("HI")
    let b = raw.boundingBoxOfPath
    let s = JK.wordCap / b.height
    let w = b.width * s
    // the web's x0 = max(left, col - w / 2), mirrored to the right edge
    let right = min(cardW / 2 - JK.wordSide, cardW / 2 - JK.wordCol + w / 2)
    let top = -cardH / 2 + JK.wordTop
    var t = CGAffineTransform(translationX: right - w, y: top).scaledBy(x: s, y: s).translatedBy(x: -b.minX, y: -b.minY)
    let path = raw.copy(using: &t)!
    return (path, path.boundingBoxOfPath)
}

/// Over the dim: the centre panel with its flourishes and the dollar, and the word.
func jokerOver(_ ctx: CGContext, _ st: Style, word: CGPath) {
    ctx.saveGState()
    let u = JK.panelW / 22   // card units per sprite pixel
    ctx.translateBy(x: JK.panelCentre.x, y: JK.panelCentre.y)
    ctx.scaleBy(x: u, y: u)
    ctx.translateBy(x: -32, y: -32)  // the panel is sprite x 21..43, y 16..48
    ctx.addPath(CGPath(roundedRect: CGRect(x: 21, y: 16, width: 22, height: 32), cornerWidth: 0.6, cornerHeight: 0.6, transform: nil))
    ctx.setFillColor(st.joker.frame); ctx.fillPath()
    ctx.setLineCap(.butt); ctx.setLineJoin(.round)
    for (sx, sy) in [(1, 1), (-1, 1), (1, -1), (-1, -1)] as [(CGFloat, CGFloat)] {
        ctx.saveGState()
        ctx.translateBy(x: sx > 0 ? 21 : 43, y: sy > 0 ? 16 : 48)
        ctx.scaleBy(x: sx, y: sy)
        ctx.move(to: CGPoint(x: 6, y: 1.5)); ctx.addLine(to: CGPoint(x: 1.5, y: 1.5)); ctx.addLine(to: CGPoint(x: 1.5, y: 6))
        ctx.addEllipse(in: CGRect(x: 2.5 - 0.95, y: 2.5 - 0.95, width: 1.9, height: 1.9))
        ctx.setStrokeColor(st.joker.flourish); ctx.setLineWidth(0.95); ctx.strokePath()
        ctx.restoreGState()
    }
    ctx.translateBy(x: 32, y: 32.5)
    ctx.scaleBy(x: JK.dollarScale, y: JK.dollarScale)
    ctx.translateBy(x: -32, y: -32.5)
    ctx.addPath(dollarPath)
    ctx.setStrokeColor(st.joker.glyph); ctx.setLineWidth(JK.dollarW / JK.dollarScale); ctx.strokePath()
    ctx.restoreGState()
    ctx.addPath(word); ctx.setFillColor(st.joker.word); ctx.fillPath()
}

// MARK: - the fan
struct Pip { let suit: String; let x: CGFloat; let y: CGFloat; let size: CGFloat; let color: CGColor }
struct Card { let angle: CGFloat; let pips: [Pip]; let joker: Bool }

struct Style {
    var face: CGColor
    var faceShade: CGColor
    var border: CGColor
    var borderW: CGFloat
    var shadow: CGColor
    var shadowBlur: CGFloat
    var ink: [String: CGColor]
    var joker: JokerInk
    var backDim: CGColor          // laid over the cards behind the front one (depth)
}

// Geometry (design units on the 1024 canvas, y down)
let cardW: CGFloat = 392
let cardH: CGFloat = cardW * 435 / 300
let cardR: CGFloat = cardW * 30 / 300
let reach: CGFloat = cardH / 2 + 80   // pivot -> card centre
let pivot = CGPoint(x: 512, y: 488 + reach) // front card centre a touch above the middle
let spread: CGFloat = 22          // degrees between neighbours

func hand(_ st: Style) -> [Card] {
    // back-to-front; pips in card-local units (origin = card centre, y down)
    let side = cardW * 0.38
    return [
        Card(angle: -spread, pips: [Pip(suit: "hearts", x: -cardW * 0.25, y: -cardH * 0.28, size: side, color: st.ink["hearts"]!)], joker: false),
        Card(angle: spread, pips: [], joker: true),
        Card(angle: 0, pips: [Pip(suit: "spades", x: 0, y: -cardH * 0.015, size: cardW * 0.74, color: st.ink["spades"]!)], joker: false),
    ]
}

func drawHand(_ ctx: CGContext, _ st: Style, scale: CGFloat = 0.94, offsetY: CGFloat = 0) {
    ctx.saveGState()
    defer { ctx.restoreGState() }
    // the whole fan scaled about the canvas centre (keeps it inside the mask's safe area)
    ctx.translateBy(x: 512, y: 512); ctx.scaleBy(x: scale, y: scale); ctx.translateBy(x: -512, y: -512)
    let rect = CGRect(x: -cardW / 2, y: -cardH / 2, width: cardW, height: cardH)
    let shape = CGPath(roundedRect: rect, cornerWidth: cardR, cornerHeight: cardR, transform: nil)
    let (word, wordBox) = jokerWord()
    for card in hand(st) {
        ctx.saveGState()
        ctx.translateBy(x: pivot.x, y: pivot.y + offsetY)
        ctx.rotate(by: card.angle * .pi / 180)
        ctx.translateBy(x: 0, y: -reach)
        // shadow
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: st.shadowBlur, color: st.shadow)
        ctx.addPath(shape); ctx.setFillColor(st.face); ctx.fillPath()
        ctx.restoreGState()
        // face with a soft vertical shade
        ctx.saveGState()
        ctx.addPath(shape); ctx.clip()
        let g = CGGradient(colorsSpace: srgb, colors: [st.face, st.faceShade] as CFArray, locations: [0.35, 1])!
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: -cardH / 2), end: CGPoint(x: 0, y: cardH / 2), options: [])
        if card.joker { jokerUnder(ctx, st, word: wordBox) }
        if card.angle != 0 { ctx.setFillColor(st.backDim); ctx.fill(rect) }
        for p in card.pips { fillSuit(ctx, p.suit, p.x, p.y, p.size, p.color) }
        if card.joker { jokerOver(ctx, st, word: word) }
        // border, inside the edge (the joker's slate edge is wider, like the web's)
        ctx.addPath(shape)
        ctx.setStrokeColor(card.joker ? st.joker.outline : st.border)
        ctx.setLineWidth(card.joker ? JK.outlineW * 2 : st.borderW * 2)
        ctx.strokePath()
        ctx.restoreGState()
        ctx.restoreGState()
    }
}

func feltBackground(_ ctx: CGContext) {
    ctx.setFillColor(feltDeep)
    ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
    let g = CGGradient(colorsSpace: srgb, colors: [feltLight, feltBase, feltDeep, feltEdge] as CFArray,
                       locations: [0, 0.45, 0.8, 1])!
    ctx.drawRadialGradient(g, startCenter: CGPoint(x: 512, y: 440), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: 512), endRadius: 760, options: .drawsAfterEndLocation)
}

let lightStyle = Style(face: cream, faceShade: creamShade, border: cardBorder, borderW: 3,
                       shadow: hex("#000000", 0.6), shadowBlur: 34,
                       ink: ["hearts": cardRed, "spades": cardBlack],
                       joker: JokerInk(outline: jokerOutline, frame: jokerFrame, flourish: jokerFlourish, glyph: jokerGlyph, word: cardRed),
                       backDim: gray(0, 0.05))

// light.png: opaque, no alpha
do {
    let ctx = makeCtx(1024, 1024, opaque: true)
    feltBackground(ctx)
    drawHand(ctx, lightStyle)
    save(ctx.makeImage()!, "icon_1024.png")
}

// dark.png: artwork on transparent; cards in deep surface tones, bright pips
let darkStyle = Style(face: hex("#2f4239"), faceShade: hex("#22312a"), border: hex("#557064"),
                      borderW: 4, shadow: hex("#000000", 0.7), shadowBlur: 34,
                      ink: ["hearts": hex("#ff5148"), "spades": hex("#f4f7f5")],
                      joker: JokerInk(outline: hex("#6f7c8e"), frame: hex("#4d6380"), flourish: hex("#9db3cf"),
                                      glyph: hex("#f4f7f5"), word: hex("#ff5148")),
                      backDim: gray(0, 0.18))
do {
    let ctx = makeCtx(1024, 1024, opaque: false)
    drawHand(ctx, darkStyle)
    save(ctx.makeImage()!, "icon_1024_dark.png")
}

// tinted.png: grayscale on black
let tintStyle = Style(face: gray(0.92), faceShade: gray(0.80), border: gray(0.55), borderW: 4,
                      shadow: gray(0, 0.8), shadowBlur: 34,
                      ink: ["hearts": gray(0.35), "spades": gray(0.08)],
                      joker: JokerInk(outline: gray(0.42), frame: gray(0.74), flourish: gray(0.97), glyph: gray(0.08), word: gray(0.35)),
                      backDim: gray(0, 0.08))
do {
    let ctx = makeCtx(1024, 1024, opaque: true)
    ctx.setFillColor(gray(0)); ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
    drawHand(ctx, tintStyle)
    save(ctx.makeImage()!, "icon_1024_tinted.png")
}

print("wrote icon_1024.png, icon_1024_dark.png and icon_1024_tinted.png in \(outDir)")
