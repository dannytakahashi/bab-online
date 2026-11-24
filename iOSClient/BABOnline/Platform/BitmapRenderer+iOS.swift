#if os(iOS)
import UIKit

extension BitmapRenderer {
    /// A bitmap of `pixelSize` pixels at scale 1 (one image point = one pixel), 8-bit sRGB
    /// (the default `.automatic` range may pick a 16-bit float extended-range bitmap on a
    /// wide-color screen, twice the bytes for colors that are all sRGB) unless
    /// `standardRange` is false (the format's default range), with alpha unless `opaque`.
    static func image(pixelSize: CGSize, opaque: Bool = false, standardRange: Bool = true,
                      _ draw: (CGContext) -> Void) -> PlatformImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = opaque
        if standardRange { format.preferredRange = .standard }
        return UIGraphicsImageRenderer(size: pixelSize, format: format).image { ctx in
            draw(ctx.cgContext)
        }
    }

    /// A bitmap of `size` points at `scale` pixels per point, 8-bit sRGB, with alpha.
    static func image(size: CGSize, scale: CGFloat, _ draw: (CGContext) -> Void) -> PlatformImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = scale
        format.opaque = false
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            draw(ctx.cgContext)
        }
    }

    /// A bitmap of `size` points in the screen's own format (its scale and range).
    static func screenImage(size: CGSize, _ draw: (CGContext) -> Void) -> PlatformImage {
        UIGraphicsImageRenderer(size: size).image { ctx in
            draw(ctx.cgContext)
        }
    }
}
#endif
