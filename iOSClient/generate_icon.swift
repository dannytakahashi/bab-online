#!/usr/bin/env swift
// Generates a 1024x1024 app icon PNG using CoreGraphics (macOS CLI compatible).

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let outputPath = "iOSClient/BABOnline/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png"

// Create bitmap context
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Failed to create CGContext")
}

let w = CGFloat(size)
let h = CGFloat(size)

// Background: dark green matching app theme
ctx.setFillColor(CGColor(red: 0.06, green: 0.15, blue: 0.08, alpha: 1.0))
ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))

// Subtle radial gradient overlay for depth
let gradientColors = [
    CGColor(red: 0.1, green: 0.25, blue: 0.12, alpha: 1.0),
    CGColor(red: 0.04, green: 0.10, blue: 0.05, alpha: 1.0),
] as CFArray
if let gradient = CGGradient(colorsSpace: colorSpace, colors: gradientColors, locations: [0.0, 1.0]) {
    ctx.drawRadialGradient(
        gradient,
        startCenter: CGPoint(x: w / 2, y: h / 2),
        startRadius: 0,
        endCenter: CGPoint(x: w / 2, y: h / 2),
        endRadius: w * 0.7,
        options: .drawsAfterEndLocation
    )
}

// Helper to draw centered text
func drawText(_ text: String, x: CGFloat, y: CGFloat, fontSize: CGFloat, color: CGColor, bold: Bool = true) {
    let fontName = bold ? "Helvetica-Bold" : "Helvetica"
    guard let font = CTFontCreateWithName(fontName as CFString, fontSize, nil) as CTFont? else { return }

    let attributes: [CFString: Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: color,
    ]
    let attrStr = CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!
    let line = CTLineCreateWithAttributedString(attrStr as CFAttributedString)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)

    ctx.saveGState()
    // CoreGraphics has Y-up, so flip for text
    ctx.textMatrix = CGAffineTransform(scaleX: 1.0, y: 1.0)
    ctx.textPosition = CGPoint(x: x - bounds.width / 2, y: y - bounds.height / 2)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
}

// Suit symbols in a 2x2 grid
let suitSize: CGFloat = 150
let gridOffset: CGFloat = 210
let centerY = h / 2 + 40  // shift up slightly to leave room for text

// Colors
let whiteColor = CGColor(red: 1, green: 1, blue: 1, alpha: 0.9)
let redColor = CGColor(red: 0.95, green: 0.35, blue: 0.35, alpha: 0.9)

// Top-left: Spade (white)
drawText("\u{2660}", x: w / 2 - gridOffset, y: centerY + gridOffset, fontSize: suitSize, color: whiteColor)
// Top-right: Heart (red)
drawText("\u{2665}", x: w / 2 + gridOffset, y: centerY + gridOffset, fontSize: suitSize, color: redColor)
// Bottom-left: Diamond (red)
drawText("\u{2666}", x: w / 2 - gridOffset, y: centerY - gridOffset, fontSize: suitSize, color: redColor)
// Bottom-right: Club (white)
drawText("\u{2663}", x: w / 2 + gridOffset, y: centerY - gridOffset, fontSize: suitSize, color: whiteColor)

// "BAB" text across center
let babColor = CGColor(red: 0.25, green: 0.85, blue: 0.45, alpha: 1.0)
drawText("BAB", x: w / 2, y: h / 2 + 40, fontSize: 200, color: babColor, bold: true)

// "ONLINE" subtitle below
let subtitleColor = CGColor(red: 1, green: 1, blue: 1, alpha: 0.7)
drawText("ONLINE", x: w / 2, y: h * 0.15, fontSize: 90, color: subtitleColor, bold: true)

// Save to PNG
guard let image = ctx.makeImage() else {
    fatalError("Failed to create image")
}

// Ensure output directory exists
let outputURL = URL(fileURLWithPath: outputPath)
let dir = outputURL.deletingLastPathComponent().path
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

guard let dest = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Failed to create image destination at \(outputPath)")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else {
    fatalError("Failed to write PNG")
}

print("Icon generated at: \(outputPath)")
