import CoreGraphics

/// Offscreen bitmaps drawn with Core Graphics (card faces, avatars, the felt, badge glyphs).
/// Shared drawing code takes the `CGContext` (top-left origin, y down), never a
/// `UIGraphicsImageRendererContext`; UIKit-style drawing (`NSString.draw`,
/// `PlatformBezierPath.fill`, `PlatformImage.draw(in:)`) draws into the same context.
/// The platform halves are `BitmapRenderer+iOS.swift` (UIGraphicsImageRenderer) and, on
/// macOS, a CGBitmapContext.
enum BitmapRenderer {}
