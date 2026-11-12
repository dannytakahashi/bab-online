import CoreGraphics

/// The spectator badge (eye + count, a 44 pt target) and its chat bubble
/// (V1_REMOVALS "iOS spectator badge" 5 and 7), placed from the solved
/// layout without changing it: the badge takes the first candidate spot that
/// keeps clear of the hand, my HSI / voice accessory, the trick cards, the
/// trick history, every seat (glow, name, bid bubble) and the corner buttons;
/// the bid band is exempt (the panel shows only on my bid turn and may cover
/// the badge then, as it does the accessory).
///
/// - Seated (a hand on screen): beside the accessory (right of it, else above
///   it at the right edge), else the left edge above the history, else under
///   the Log button.
/// - Spectating (no hand): the bottom-right corner, above the pill.
/// Then the clear spot nearest the first candidate; on a packed table the
/// bid bubbles and history may be covered (never the always-on parts); where
/// even that fails (a degraded layout) the first candidate clamped into the
/// safe rect.
extension TableLayout {
    /// Wide enough for the badge's widest form ("99+" at its Dynamic Type cap, .large;
    /// SpectatorBadgeFitTests measures it) and no wider: 66 pt no longer keeps clear on an SE.
    static let spectatorBadgeSize = CGSize(width: 60, height: 44)

    /// The badge's rect in scene coordinates.
    func spectatorBadge(spectating: Bool) -> CGRect {
        let cands = spectatorBadgeCandidates(spectating: spectating)
        let all = spectatorKeeps(spectating: spectating)
        for c in cands where isClear(c, keeps: all) { return c }
        let first = cands.first ?? .zero
        if let r = nearestClear(to: first, keeps: all) { return r }
        // a packed table (an SE-size window at zero insets): clear of everything that is always on
        // screen, over a bid bubble or the trick history at worst
        let hard = spectatorKeeps(spectating: spectating, soft: false)
        for c in cands where isClear(c, keeps: hard) { return c }
        return nearestClear(to: first, keeps: hard) ?? clampIntoSafe(first)
    }

    /// The clear spot nearest `first`, along the right and left edges and `first`'s row
    /// (2 pt steps: a few hundred rects).
    private func nearestClear(to first: CGRect, keeps: [CGRect]) -> CGRect? {
        let w = Self.spectatorBadgeSize.width, h = Self.spectatorBadgeSize.height
        var best: CGRect?
        var bestD = CGFloat.infinity
        func consider(_ x: CGFloat, _ y: CGFloat) {
            let r = CGRect(x: x, y: y, width: w, height: h)
            let d = hypot(x - first.minX, y - first.minY)
            if d < bestD, isClear(r, keeps: keeps) { best = r; bestD = d }
        }
        let top = min(safeRect.maxY, topLimit) - h
        var y = safeRect.minY
        while y <= top {
            consider(safeRect.maxX - Self.margin - w, y)
            consider(safeRect.minX + Self.margin, y)
            y += 2
        }
        var x = safeRect.minX + Self.margin
        while x <= safeRect.maxX - Self.margin - w {
            consider(x, first.minY)
            x += 2
        }
        return best
    }

    /// What the badge (and its bubble) must not cover. `soft: false` leaves out what is on
    /// screen only part of the time (the bid bubbles: bidding and the first trick; the history).
    func spectatorKeeps(spectating: Bool, soft: Bool = true) -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats {
            keeps.append(seatFootprint(r))
            if soft { keeps.append(bubbleRect(r)) }
        }
        if soft { keeps.append(historyRect) }
        keeps.append(contentsOf: cornerRects)
        if !spectating {
            keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
            keeps.append(accessoryContent)
            if soft { keeps.append(bubbleRect(.bottom)) }
        }
        return keeps
    }

    /// What HSI + voice really cover inside `accessory` (GameContainerView draws them bottom-leading:
    /// a 124 x 48 row, or an 84 x 76 stack where the rect is narrower).
    var accessoryContent: CGRect {
        let s = accessoryStacked ? Self.accessoryStack : Self.accessoryRow
        return CGRect(x: accessory.minX, y: accessory.minY, width: min(s.width, accessory.width), height: min(s.height, accessory.height))
    }

    /// The trick history's two rows (Q2: left of my trick slot).
    var historyRect: CGRect {
        let w = Self.historyIcon.width + 12 * historySpacing
        return CGRect(x: historyOrigin.x - Self.historyIcon.width / 2, y: historyOrigin.y + Self.historyIcon.height / 2 - Self.historyHeight,
                      width: w, height: Self.historyHeight)
    }

    private func spectatorBadgeCandidates(spectating: Bool) -> [CGRect] {
        let w = Self.spectatorBadgeSize.width, h = Self.spectatorBadgeSize.height
        let G = Self.gap, M = Self.margin
        let right = safeRect.maxX - M - w, left = safeRect.minX + M
        let underLog = (cornerRects.last?.minY ?? topLimit) - G - h
        if spectating {
            let floor = safeRect.minY + max(12, chrome.bottomBar + G)
            return [CGRect(x: right, y: floor, width: w, height: h),
                    CGRect(x: right, y: floor + h + G, width: w, height: h),
                    CGRect(x: right, y: underLog, width: w, height: h)]
        }
        return [CGRect(x: accessoryContent.maxX + G, y: accessory.minY, width: w, height: h),
                CGRect(x: right, y: accessory.maxY + G, width: w, height: h),
                CGRect(x: right, y: accessory.minY + Self.accessoryRow.height + G, width: w, height: h),
                CGRect(x: left, y: historyRect.maxY + G, width: w, height: h),
                CGRect(x: right, y: underLog, width: w, height: h)]
    }

    private func isClear(_ r: CGRect, keeps: [CGRect]) -> Bool {
        guard r.minX >= safeRect.minX - 0.01, r.maxX <= safeRect.maxX + 0.01, r.minY >= safeRect.minY - 0.01,
              r.maxY <= topLimit + 0.01 else { return false }
        if let f = chrome.fold, f.intersects(r) { return false }
        return !keeps.contains { k in Self.overlaps(k, r) }
    }

    static func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
        min(a.maxX, b.maxX) - max(a.minX, b.minX) > 0.01 && min(a.maxY, b.maxY) - max(a.minY, b.minY) > 0.01
    }

    private func clampIntoSafe(_ r: CGRect) -> CGRect {
        func c(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { lo <= hi ? min(max(v, lo), hi) : lo }
        let top = min(safeRect.maxY, topLimit)
        return CGRect(x: c(r.minX, safeRect.minX, safeRect.maxX - r.width), y: c(r.minY, safeRect.minY, top - r.height),
                      width: r.width, height: r.height)
    }

    /// The spectator chat bubble's center (`size` measured): above the badge, right-aligned
    /// with it; else left of it; else below it; clear of the same keeps where it can be,
    /// always inside the safe rect below the top bar.
    func spectatorBubbleCenter(badge: CGRect, bubbleSize size: CGSize, spectating: Bool) -> CGPoint {
        let G = Self.gap, M = Self.margin
        // the bid panel covers the transient layer on my bid turn: keep the bubble off its band
        let keeps = spectatorKeeps(spectating: spectating) + (spectating ? [] : [bidBand])
        let minX = safeRect.minX + M, maxX = safeRect.maxX - M
        func fit(_ x: CGFloat) -> CGFloat { min(max(x, minX), max(minX, maxX - size.width)) }
        func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: fit(x), y: y, width: size.width, height: size.height) }
        var spots = [
            at(badge.maxX - size.width, badge.maxY + G),
            at(badge.minX - G - size.width, badge.midY - size.height / 2),
            at(badge.maxX - size.width, badge.minY - G - size.height),
        ]
        // then higher up the badge's edge (past a trick card or a bid bubble), 4 pt steps
        var y = badge.maxY + G + 4
        while y + size.height <= topLimit {
            spots.append(at(badge.maxX - size.width, y))
            y += 4
        }
        // a phone has little room by the badge: like a seat's chat bubble, a 5 s spectator line may
        // then cover a trick slot, a bid bubble or the history, never a seat, the hand, HSI / voice,
        // the corner buttons or (seated) the bid band
        let chosen = spots.first { isClear($0, keeps: keeps) }
            ?? spots.first { isClear($0, keeps: spectatorBubbleHardKeeps(spectating: spectating)) }
            ?? clampIntoSafe(spots[0])
        return CGPoint(x: chosen.midX, y: chosen.midY)
    }

    /// What a spectator chat bubble never covers.
    func spectatorBubbleHardKeeps(spectating: Bool) -> [CGRect] {
        var keeps = spectatorKeeps(spectating: spectating, soft: false).filter { k in
            ![Positions.RelativePosition.top, .left, .right, .bottom].contains { trickRect($0) == k }
        }
        if !spectating { keeps.append(bidBand) }
        return keeps
    }
}
