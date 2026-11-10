import SwiftUI

/// Reserved display regions (iOS 27.1 SDK, `GeometryProxy.reservedRegions`),
/// read in a GeometryReader's body. Compiles and returns nothing on earlier
/// systems (the app targets iOS 17).
enum FoldReader {
    /// The active division (the fold) in the proxy's local coordinates, if any.
    /// Wider than tall = tabletop (table above, hand below); taller than wide = book.
    static func division(_ p: GeometryProxy) -> CGRect? {
        #if DEBUG
        if let fold = UIFixture.fold { return synthetic(fold, p) }
        #endif
        if #available(iOS 27.1, *) {
            return p.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).first(where: \.isActive)?.frame
        }
        return nil
    }

    /// A book fold's hinge as a proxy-local x span, when the vertical division
    /// lies inside the proxy and leaves both pages at least `minPage` wide: the
    /// wide lobbies end their left column at it and start the right one after it.
    static func bookHinge(_ p: GeometryProxy, minPage: CGFloat = 240) -> ClosedRange<CGFloat>? {
        guard let d = division(p), d.height > d.width,
              d.minX >= minPage, p.size.width - d.maxX >= minPage else { return nil }
        return d.minX.rounded(.down)...d.maxX.rounded(.up)
    }

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

    #if DEBUG
    /// `-uiFold`: a 20 pt division at the window center (screenshots of the composition only).
    private static func synthetic(_ fold: UIFixture.Fold, _ p: GeometryProxy) -> CGRect {
        let i = p.safeAreaInsets
        let w = p.size.width + i.leading + i.trailing, h = p.size.height + i.top + i.bottom
        switch fold {
        case .book: return CGRect(x: w / 2 - 10 - i.leading, y: -i.top, width: 20, height: h)
        case .tabletop: return CGRect(x: -i.leading, y: h / 2 - 10 - i.top, width: w, height: 20)
        }
    }
    #endif
}

/// Bumps a counter on every hinge change (iOS 27.1 SDK), so a GeometryReader
/// that reads FoldReader re-evaluates even when its size does not change.
struct HingeTick: ViewModifier {
    @Binding var tick: Int

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, _ in tick &+= 1 }
        } else {
            content
        }
    }
}
