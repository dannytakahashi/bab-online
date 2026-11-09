import SwiftUI

/// Reserved display regions (iOS 27.1 SDK, `GeometryProxy.reservedRegions`),
/// read in the table pane's GeometryReader. Compiles and returns nothing on
/// earlier systems (the app targets iOS 17).
enum FoldReader {
    /// Active occlusions (system UI drawn over the app), in the proxy's local coordinates.
    static func occlusions(_ p: GeometryProxy) -> [CGRect] {
        if #available(iOS 27.1, *) {
            return p.reservedRegions(kind: .occlusion, layoutDirectionBehavior: .fixed).filter(\.isActive).map(\.frame)
        }
        return []
    }

    /// A proxy-local rect in scene coordinates (center origin, y up) of the
    /// full pane: the proxy's frame starts `insets` inside the pane.
    static func toScene(_ r: CGRect, in full: CGSize, insets: EdgeInsets) -> CGRect {
        let x = r.minX + insets.leading, maxY = r.maxY + insets.top
        return CGRect(x: x - full.width / 2, y: full.height / 2 - maxY, width: r.width, height: r.height)
    }
}
