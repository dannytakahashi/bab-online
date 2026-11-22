import CoreGraphics

/// The watched player's chat bubble in the over-the-shoulder view (owner 2026-11-21 follow-up to
/// #371: "the watched player's chat bubble covers their hand"). A seat never sees its own line in
/// a bubble (the log has it), so the bottom seat's bubble is only ever a watcher's, and the
/// generic `chatPosition(.bottom)` (a plain spectator's bottom avatar, which sits on the hand's
/// baseline) put it over the watched hand's corner indices. It goes where the web's watcher sees
/// it, by the watched seat's box: just above the hand, beside the watched seat's row (HSI and
/// its pips), never on the hand.
///
/// Placement (scene coordinates): the clear spot nearest the preferred one (just above the hand,
/// its right edge 8 pt left of the watched seat's row; while that seat bids, just above the
/// read-only bid sheet), on a 4 pt grid of the safe area, 4 pt off what it keeps clear of. What
/// it may cover, least harmful first, in tiers (`WatchedChatTier`):
///  1. nothing: clear of the hand and the band a card would lift into (the dealer button and
///     the eye chip live there), the bottom pill, the watched seat's row (HSI and its pips), the
///     watcher's mic and eye, the corner buttons, the read-only bid sheet with its clock
///     (bidding), the /help column as drawn (`column`: the SwiftUI cards are over the scene, so a
///     bubble under them is hidden), the trick cards (play), the seats' avatars and names, the
///     watched seat's bid bubble, the piles, the other seats' bid bubbles and dealer buttons,
///     the card backs, the banner and the fold;
///  2. the other seats' bid bubbles, dealer buttons, card backs and the banner;
///  3. the piles too (a phone with the /help column up and a long line: the band beside the row
///     is the only room left, and the piles fill most of it);
///  4. the seats' avatars and names and the watched seat's bid bubble too;
///  5. the trick cards too;
///  6. anything but the hand (a pane with no other room).
/// Each tier is tried at every width, widest first (`SKChatBubbleManager.watchedWidths`), so a
/// narrower bubble in a better tier wins over a wider one in a worse tier. Never on the hand.
extension TableLayout {
    /// The gap the bubble keeps from what it keeps clear of.
    static let watchedChatGap: CGFloat = 4

    enum WatchedChatTier: Int, CaseIterable { case clear = 1, backs, piles, seats, tricks, handOnly }

    /// The hand and the band a lifted card rises into (the watched hand never lifts, but its
    /// dealer button and eye chip sit in that band), across the safe area.
    var watchedHandBand: CGRect {
        CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY))
    }

    /// What tier `tier` keeps clear of (scene coordinates). `column`: the /help column's visible
    /// frame in scene coordinates while it shows.
    func watchedChatKeeps(bidding: Bool, column: CGRect?, tier: WatchedChatTier) -> [CGRect] {
        var keeps = [watchedHandBand, bottomBarRect]
        guard tier != .handOnly else { return keeps }
        let cluster = watcherCluster(bidding: bidding)
        keeps += [seatRow.content, cluster.badge, cluster.voice]
        keeps += cornerRects
        if bidding { keeps += bidSheetKeeps }
        if let column { keeps.append(column) }
        guard tier != .tricks else { return keeps }
        if !bidding { keeps += [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect) }
        guard tier != .seats else { return keeps }
        let others: [Positions.RelativePosition] = [.top, .left, .right]
        keeps += others.map(seatFootprint)
        keeps.append(bubbleRect(.bottom))
        guard tier != .piles else { return keeps }
        let m = TrickHistoryNode.borderPad + 2
        keeps.append(historyRect.insetBy(dx: -m, dy: -m))
        guard tier == .clear else { return keeps }
        for r in others { keeps += [bubbleRect(r), dealerChip(r)] }
        keeps += Array((fans(spectating: false) ?? [:]).values)
        if let banner = bannerRect(spectating: false) { keeps.append(banner) }
        return keeps
    }

    /// Where the search starts: just above the hand, right-aligned 8 pt left of the watched
    /// seat's row (on its baseline); while the watched seat bids, just above the read-only sheet.
    func watchedChatPreferred(bubbleSize s: CGSize, bidding: Bool) -> CGPoint {
        let G = Self.watchedChatGap
        if bidding {
            return CGPoint(x: bidBand.minX, y: bidBand.maxY + 2 + G)
        }
        let row = seatRow.content
        let right = row.width > 0 ? row.minX - Self.seatRowGap : trickSlot(.bottom).x + s.width / 2
        return CGPoint(x: right - s.width, y: liftTop + G)
    }

    /// The bubble's rect for `tier`, or nil when no spot keeps clear at that tier.
    func watchedChatRect(bubbleSize s: CGSize, bidding: Bool, column: CGRect?, tier: WatchedChatTier) -> CGRect? {
        let G = Self.watchedChatGap
        let keeps = watchedChatKeeps(bidding: bidding, column: column, tier: tier).map { $0.insetBy(dx: -G, dy: -G) }
        let first = watchedChatPreferred(bubbleSize: s, bidding: bidding)
        let fold = foldIgnored ? nil : chrome.fold
        func clear(_ r: CGRect) -> Bool {
            if let f = fold, Self.overlaps(f, r) { return false }
            return !keeps.contains { Self.overlaps($0, r) }
        }
        let M = Self.margin
        let lo = safeRect.minX + M, hi = safeRect.maxX - M - s.width
        let top = min(safeRect.maxY, topLimit) - s.height
        guard hi >= lo else { return nil }
        let x0 = min(max(first.x, lo), hi)
        var best: CGRect?
        var bestD = CGFloat.infinity
        var y = max(safeRect.minY, liftTop + G)
        while y <= top {
            // the preferred x itself, then the 4 pt grid
            var xs: [CGFloat] = [x0]
            var x = lo
            while x <= hi { xs.append(x); x += 4 }
            xs.append(hi)
            for x in xs {
                let r = CGRect(x: x, y: y, width: s.width, height: s.height)
                let d = hypot(x - x0, y - first.y)
                if d < bestD, clear(r) { best = r; bestD = d }
            }
            y += 4
        }
        return best
    }

    /// The last resort (no tier found a spot): just above the hand, centred, under the score bar.
    func watchedChatFallback(bubbleSize s: CGSize) -> CGRect {
        let x = min(max(trickSlot(.bottom).x - s.width / 2, safeRect.minX), max(safeRect.minX, safeRect.maxX - s.width))
        return CGRect(x: x, y: liftTop + Self.watchedChatGap, width: s.width, height: s.height)
    }

    /// A pane rect (the full pane's top-left points, `window(_:)`'s output) in scene coordinates.
    func scene(fromWindow r: CGRect) -> CGRect {
        let z = max(zoom, 0.0001)
        return CGRect(x: r.minX / z - size.width / 2, y: size.height / 2 - r.maxY / z, width: r.width / z, height: r.height / z)
    }
}
