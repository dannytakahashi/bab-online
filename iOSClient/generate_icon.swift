#!/usr/bin/env swift
// The BAB Online app icon (1.2.0 build 6): a fanned hand on the felt, a black
// spade in front of a red heart and the purple joker star.
// Writes the three appearances of AppIcon.appiconset:
//   icon_1024.png         any / light: opaque, no alpha (App Store requirement)
//   icon_1024_dark.png    dark: the cards on a transparent background
//   icon_1024_tinted.png  tinted: grayscale on black (iOS colourises it)
// Run from the repo root: swift iOSClient/generate_icon.swift
// then npm run build:icons for the web favicon, touch icon and phone gate art.
//
// Palette from client/tokens/tokens.json (felt greens, card red/black/joker);
// suit shapes are the SUIT_PATHS of client/src/phaser/cards/cardFaces.js
// (100 x 100 box, y down), the joker star is its drawStar.

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
let cardRed = hex("#d91a1a"), cardBlack = hex("#1a1a1a"), cardJoker = hex("#800080")
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
    default: // joker star (drawStar), centred in the box, outer radius 50
        for i in 0..<10 {
            let a = -CGFloat.pi / 2 + CGFloat(i) * .pi / 5
            let r: CGFloat = i % 2 == 0 ? 50 : 50 * 0.382
            let pt = CGPoint(x: 50 + r * cos(a), y: 54 + r * sin(a))
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
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

// MARK: - the fan
struct Pip { let suit: String; let x: CGFloat; let y: CGFloat; let size: CGFloat; let color: CGColor }
struct Card { let angle: CGFloat; let pips: [Pip]; let joker: Bool }

struct Style {
    var face: CGColor
    var faceShade: CGColor
    var border: CGColor
    var jokerBorder: CGColor
    var borderW: CGFloat
    var shadow: CGColor
    var shadowBlur: CGFloat
    var ink: [String: CGColor]
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
        Card(angle: spread, pips: [Pip(suit: "star", x: cardW * 0.25, y: -cardH * 0.29, size: side * 1.1, color: st.ink["star"]!)], joker: true),
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
        if card.angle != 0 { ctx.setFillColor(st.backDim); ctx.fill(rect) }
        for p in card.pips { fillSuit(ctx, p.suit, p.x, p.y, p.size, p.color) }
        // border, inside the edge
        ctx.addPath(shape)
        ctx.setStrokeColor(card.joker ? st.jokerBorder : st.border)
        ctx.setLineWidth(st.borderW * 2)
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

let lightStyle = Style(face: cream, faceShade: creamShade, border: cardBorder, jokerBorder: cardJoker, borderW: 3,
                       shadow: hex("#000000", 0.6), shadowBlur: 34,
                       ink: ["hearts": cardRed, "spades": cardBlack, "star": cardJoker], backDim: gray(0, 0.05))

// light.png: opaque, no alpha
do {
    let ctx = makeCtx(1024, 1024, opaque: true)
    feltBackground(ctx)
    drawHand(ctx, lightStyle)
    save(ctx.makeImage()!, "icon_1024.png")
}

// dark.png: artwork on transparent; cards in deep surface tones, bright pips
let darkStyle = Style(face: hex("#2f4239"), faceShade: hex("#22312a"), border: hex("#557064"), jokerBorder: hex("#b25ad6"),
                      borderW: 4, shadow: hex("#000000", 0.7), shadowBlur: 34,
                      ink: ["hearts": hex("#ff5148"), "spades": hex("#f4f7f5"), "star": hex("#c26be6")], backDim: gray(0, 0.18))
do {
    let ctx = makeCtx(1024, 1024, opaque: false)
    drawHand(ctx, darkStyle)
    save(ctx.makeImage()!, "icon_1024_dark.png")
}

// tinted.png: grayscale on black
let tintStyle = Style(face: gray(0.92), faceShade: gray(0.80), border: gray(0.55), jokerBorder: gray(0.55), borderW: 4,
                      shadow: gray(0, 0.8), shadowBlur: 34,
                      ink: ["hearts": gray(0.35), "spades": gray(0.08), "star": gray(0.35)], backDim: gray(0, 0.08))
do {
    let ctx = makeCtx(1024, 1024, opaque: true)
    ctx.setFillColor(gray(0)); ctx.fill(CGRect(x: 0, y: 0, width: S, height: S))
    drawHand(ctx, tintStyle)
    save(ctx.makeImage()!, "icon_1024_tinted.png")
}

print("wrote icon_1024.png, icon_1024_dark.png and icon_1024_tinted.png in \(outDir)")
