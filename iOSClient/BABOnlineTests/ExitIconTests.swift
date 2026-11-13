import XCTest
import SwiftUI
@testable import BAB_Online

/// 1.2.0 (5): the Exit icon points left in the iPhone Duo's vertical bar too. The bar
/// draws a toolbar item's image itself and ignores a SwiftUI mirror, so the bar's
/// image is the symbol already mirrored (owner, 2026-11-12).
@MainActor
final class ExitIconTests: XCTestCase {
    /// RGBA pixels of an image drawn at its own pixel size (optionally mirrored).
    private func pixels(_ image: UIImage, mirrored: Bool = false) -> (bytes: [UInt8], width: Int, height: Int) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { context in
            if mirrored {
                context.cgContext.translateBy(x: image.size.width, y: 0)
                context.cgContext.scaleBy(x: -1, y: 1)
            }
            image.draw(at: .zero)
        }
        let cg = rendered.cgImage!
        let w = cg.width, h = cg.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (bytes, w, h)
    }

    /// The symbol as the bar would draw it unmirrored (body, large scale, medium weight).
    private func symbol(_ size: DynamicTypeSize = .large, bold: Bool = false) -> UIImage {
        let traits = UITraitCollection { t in
            t.preferredContentSizeCategory = UIContentSizeCategory(size)
            t.legibilityWeight = bold ? .bold : .regular
        }
        let configuration = UIImage.SymbolConfiguration(textStyle: .body, scale: .large)
            .applying(UIImage.SymbolConfiguration(weight: bold ? .bold : .medium))
            .withTraitCollection(traits)
        return UIImage(systemName: ExitIcon.symbolName, withConfiguration: configuration)!
    }

    /// Where the ink of the top quarter sits, 0 (left edge) to 1 (right edge): only the
    /// rectangle reaches up there (the arrow is at mid-height), on the side away from the arrow.
    private func topInkCentroid(_ p: (bytes: [UInt8], width: Int, height: Int)) -> Double {
        var sum = 0.0, weight = 0.0
        for y in 0..<(p.height / 4) { for x in 0..<p.width {
            let a = Double(p.bytes[(y * p.width + x) * 4 + 3])
            sum += a * (Double(x) + 0.5); weight += a
        } }
        return sum / weight / Double(p.width)
    }

    /// Total ink (alpha).
    private func ink(_ p: (bytes: [UInt8], width: Int, height: Int)) -> Int {
        stride(from: 3, to: p.bytes.count, by: 4).reduce(0) { $0 + Int(p.bytes[$1]) }
    }

    func testBarImageIsTheMirroredSymbol() {
        let bar = ExitIcon.barImage()
        let plain = symbol()
        XCTAssertEqual(bar.renderingMode, .alwaysTemplate, "the bar tints it like its other items")
        XCTAssertNil(bar.symbolConfiguration, "a bitmap: the bar re-draws a symbol image unmirrored")
        XCTAssertEqual(bar.size.width, plain.size.width, accuracy: 0.34)
        XCTAssertEqual(bar.size.height, plain.size.height, accuracy: 0.34)
        let b = pixels(bar), m = pixels(plain, mirrored: true), u = pixels(plain)
        XCTAssertEqual(b.width, m.width); XCTAssertEqual(b.height, m.height)
        var maxAlphaDiff = 0, maxAlphaDiffUnmirrored = 0
        for i in stride(from: 3, to: b.bytes.count, by: 4) {
            maxAlphaDiff = max(maxAlphaDiff, abs(Int(b.bytes[i]) - Int(m.bytes[i])))
            maxAlphaDiffUnmirrored = max(maxAlphaDiffUnmirrored, abs(Int(b.bytes[i]) - Int(u.bytes[i])))
        }
        XCTAssertLessThanOrEqual(maxAlphaDiff, 2, "the bar image is the symbol mirrored")
        XCTAssertGreaterThan(maxAlphaDiffUnmirrored, 100, "and not the symbol as is")
        // the rectangle is on the left of the symbol (its arrow points right) and on the right of the bar's image
        XCTAssertLessThan(topInkCentroid(u), 0.45, "the symbol's arrow points right")
        XCTAssertGreaterThan(topInkCentroid(b), 0.55, "the bar's arrow points left")
    }

    /// As the bar's own symbols: larger with Dynamic Type up to xxLarge, then capped; bolder with Bold Text.
    func testBarImageFollowsTheBarsSymbolSize() {
        for size in [DynamicTypeSize.xSmall, .large, .xLarge, .xxLarge] {
            XCTAssertEqual(ExitIcon.barImage(dynamicTypeSize: size).size.width, symbol(size).size.width, accuracy: 0.34, "\(size)")
            XCTAssertEqual(ExitIcon.barImage(dynamicTypeSize: size).size.height, symbol(size).size.height, accuracy: 0.34, "\(size)")
        }
        XCTAssertGreaterThan(ExitIcon.barImage(dynamicTypeSize: .xxLarge).size.width, ExitIcon.barImage().size.width)
        XCTAssertLessThan(ExitIcon.barImage(dynamicTypeSize: .xSmall).size.width, ExitIcon.barImage().size.width)
        XCTAssertEqual(ExitIcon.barImage(dynamicTypeSize: .accessibility5).size, ExitIcon.barImage(dynamicTypeSize: .xxLarge).size)
        XCTAssertGreaterThan(ink(pixels(ExitIcon.barImage(legibilityWeight: .bold))), ink(pixels(ExitIcon.barImage())) * 5 / 4,
                             "Bold Text draws heavier strokes")
    }

    /// The bar's Exit uses the mirrored image, never the plain symbol or a SwiftUI mirror the bar drops.
    func testBarButtonUsesTheMirroredImage() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BABOnline/Views/Game/GameContainerView.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private var leaveBarButton: some View {"))
        let end = try XCTUnwrap(source.range(of: "private var leaveLabel", range: start.upperBound..<source.endIndex))
        let body = source[start.upperBound..<end.lowerBound]
        XCTAssertTrue(body.contains("Image(uiImage: ExitIcon.barImage("), "the bar's Exit draws the mirrored image")
        XCTAssertFalse(body.contains("Image(systemName:"), "a symbol in the bar is drawn unmirrored")
        XCTAssertFalse(body.contains(".scaleEffect("), "the bar ignores SwiftUI transforms")
        let lines = body.components(separatedBy: "\n")
        for i in lines.indices where lines[i].contains("Image(uiImage: ExitIcon.barImage(") {
            XCTAssertTrue(lines[i + 1].contains(".accessibilityHidden(true)"), "the bar's Exit icon is decorative")
        }
    }
}
