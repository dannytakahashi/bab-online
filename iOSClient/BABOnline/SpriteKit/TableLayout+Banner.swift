import CoreGraphics

/// The disconnect banner ("X disconnected", "Replace with Bot"; SwiftUI) keeps
/// off the seat avatars where the table has the room: just below the partner's
/// seat (its glow and name), centred, at most `disconnectBannerMaxWidth`
/// wide, when that rect is clear of every seat, the trick cards, the history,
/// HSI / voice, the hand, the corner buttons and the fold (the iPad, a tall
/// window). On a phone the partner and the trick cluster leave no such gap
/// (15 pt at most between the partner's glow and the top trick card, and the
/// side seats and the cluster fill every row below), so there is no clear
/// spot (nil) and the banner keeps its place under the corner buttons, over
/// the partner: it is transient and names who is away.
extension TableLayout {
    static let disconnectBannerMaxWidth: CGFloat = 420

    /// The banner's rect (scene coordinates) for its measured `height`, or nil.
    func disconnectBanner(height h: CGFloat, spectating: Bool) -> CGRect? {
        guard h > 0 else { return nil }
        let w = min(Self.disconnectBannerMaxWidth, safeRect.width - 2 * Self.margin)
        guard w > 0 else { return nil }
        let x = safeRect.midX - w / 2
        let top = seatFootprint(.top).minY - Self.gap
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats { keeps.append(seatFootprint(r)); keeps.append(bubbleRect(r)) }
        keeps.append(historyRect)
        keeps.append(contentsOf: cornerRects)
        if !spectating {
            keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
            keeps.append(accessoryContent)
            keeps.append(myPips)
        }
        if let f = chrome.fold, !foldIgnored { keeps.append(f) }
        let r = CGRect(x: x, y: top - h, width: w, height: h)
        guard r.minY >= safeRect.minY, !keeps.contains(where: { Self.overlaps($0, r) }) else { return nil }
        return r
    }
}
