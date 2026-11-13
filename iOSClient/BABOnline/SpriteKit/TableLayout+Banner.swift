import CoreGraphics

/// The disconnect banner ("X disconnected", "Replace with Bot"; SwiftUI) keeps
/// off the seat avatars where the table has the room: the highest full-width
/// strip (centred, at most `disconnectBannerMaxWidth` wide; right under the
/// top bar between the corner buttons on a wide window) that is clear of every seat, the trick cards, the history,
/// HSI / voice, the hand, the corner buttons and the fold (the iPad, a tall
/// window). On a phone the partner and the trick cluster leave no such gap
/// (15 pt at most between the partner's glow and the top trick card, and the
/// side seats and the cluster fill every row below), so there is no clear
/// spot (nil) and the banner keeps its place under the corner buttons, over
/// the partner: it is transient and names who is away.
extension TableLayout {
    static let disconnectBannerMaxWidth: CGFloat = 420

    /// The banner's rect (scene coordinates) for its `height` in scene units (GameContainerView
    /// divides the measured points by `zoom`), or nil.
    func disconnectBanner(height h: CGFloat, spectating: Bool) -> CGRect? {
        guard h > 0 else { return nil }
        // the banner is at most 420 POINTS wide (GameContainerView's frame): 420 / zoom scene units
        let w = min(Self.disconnectBannerMaxWidth / zoom, safeRect.width - 2 * Self.margin)
        guard w > 0 else { return nil }
        let x = safeRect.midX - w / 2
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats { keeps.append(seatFootprint(r)); keeps.append(bubbleRect(r)) }
        keeps.append(historyRect)
        keeps.append(contentsOf: cornerRects)
        if !spectating {
            keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
            keeps.append(accessoryContent)  // my seat's row: my pips, HSI, voice
            keeps.append(bidBand)  // never over my bid panel's buttons
        }
        keeps.append(spectatorBadge(spectating: spectating))
        if let f = chrome.fold, !foldIgnored { keeps.append(f) }
        // the highest clear strip: right under the top bar between the corner buttons (a wide
        // window), else lower down (below the partner where the cluster leaves room)
        var y = topLimit - h
        while y >= safeRect.minY {
            let r = CGRect(x: x, y: y, width: w, height: h)
            if !keeps.contains(where: { Self.overlaps($0, r) }) { return r }
            y -= 2
        }
        return nil
    }
}
