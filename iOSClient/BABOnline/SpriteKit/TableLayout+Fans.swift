import CoreGraphics

/// Opponent card backs and the dealer marker (iOS 1.2.2; the web's
/// OpponentManager.displayOpponentHands / displayDealerButton), placed from the
/// solved layout without changing it, like the pips, my seat's row and the
/// spectator badge.
///
/// Card backs: each other seat (a spectator's four) holds a small fan of card
/// backs, one per card left in its hand, in a fixed box (`fanBox`, sized for 13
/// cards, so nothing moves as cards are played). The box takes the first clear
/// spot by the seat: above the avatar, and for the top seat also left of it
/// (the bid bubble is on its right). "Clear" is `fanGap` from the trick cards,
/// every seat (glow, name, bid bubble), the other fans, the corner buttons, the
/// trick piles, my seat's row, my lifted hand, the fold, the spectator badge
/// and the safe area's edges. Fans are all or nothing: when any seat has no
/// clear spot, or the layout is degraded, the table shows none (opponents are
/// the lightweight anchors of before: the fans were removed in eb73520 because
/// full-size backs crowded a phone table).
///
/// Transient things may cover a fan for a few seconds: a seat's chat bubble
/// (it opens above the seat), a rainbow, the disconnect banner.
///
/// Dealer marker: a small "D" button. On a seat with an avatar it sits beside
/// the avatar, inside the seat's footprint (glow + name band), which everything
/// else already keeps clear of, on the side away from the seat's bid bubble.
/// My own seat has no avatar: mine sits at the left end of my hand, in the band
/// a lifted card rises into (nothing else is ever placed there).
extension TableLayout {
    /// One card back of a fan (the card's 100 : 145).
    static let fanCard = CGSize(width: 26, height: 37.7)
    /// Between two backs.
    static let fanStep: CGFloat = 5
    /// The fan's turn per card, radians (the outer cards lean out).
    static let fanTurn: CGFloat = 0.04
    /// How much a card drops per squared point from the fan's centre.
    static let fanDrop: CGFloat = 0.0012
    /// The room a 13-card fan takes (its rotated cards included).
    static let fanBox = CGSize(width: 96, height: 46)
    /// The clear gap around a fan.
    static let fanGap: CGFloat = 4
    static let fanMaxCards = 13

    /// A card back's place in its fan: centre (relative to the box's centre, y up) and rotation.
    struct FanSlot: Equatable {
        let center: CGPoint
        let rotation: CGFloat
    }

    /// Slots for `count` backs, left to right (at most `fanMaxCards`): a pure function of the count.
    static func fanSlots(count: Int) -> [FanSlot] {
        let n = min(max(count, 0), fanMaxCards)
        return (0..<n).map { i in
            let t = CGFloat(i) - CGFloat(n - 1) / 2
            let x = t * fanStep
            return FanSlot(center: CGPoint(x: x, y: -fanDrop * x * x), rotation: -t * fanTurn)
        }
    }

    /// The bounds of one slot's rotated card (relative to the box's centre).
    static func fanCardBounds(_ slot: FanSlot) -> CGRect {
        let c = abs(cos(slot.rotation)), s = abs(sin(slot.rotation))
        let w = fanCard.width * c + fanCard.height * s, h = fanCard.width * s + fanCard.height * c
        return CGRect(x: slot.center.x - w / 2, y: slot.center.y - h / 2, width: w, height: h)
    }

    /// Every seat's fan box (scene coordinates), or nil when the table has no room for all of them.
    func fans(spectating: Bool) -> [Positions.RelativePosition: CGRect]? {
        guard !isDegraded, size.width > 0, size.height > 0 else { return nil }
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        let keeps = fanKeeps(spectating: spectating)
        var out: [Positions.RelativePosition: CGRect] = [:]
        for r in seats {
            guard let box = fanCandidates(r).first(where: { c in
                fanIsClear(c, keeps: keeps) && !out.values.contains { Self.overlaps($0.insetBy(dx: -Self.fanGap, dy: -Self.fanGap), c) }
            }) else { return nil }
            out[r] = box
        }
        return out
    }

    /// Where a seat's fan may go, best first.
    private func fanCandidates(_ r: Positions.RelativePosition) -> [CGRect] {
        let a = seatAnchor(r)
        let b = Self.fanBox
        let above = CGRect(x: a.x - b.width / 2, y: a.y + Self.glowRadius + Self.gap, width: b.width, height: b.height)
        guard r == .top else { return [above] }
        // beside the avatar, past the name band's edge (the dealer marker sits inside it)
        let left = CGRect(x: a.x - Self.nameMaxWidth / 2 - Self.gap - b.width, y: a.y - b.height / 2, width: b.width, height: b.height)
        return [above, left]
    }

    /// What no fan may touch.
    private func fanKeeps(spectating: Bool) -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats {
            keeps.append(seatFootprint(r))
            keeps.append(bubbleRect(r))
        }
        let m = TrickHistoryNode.borderPad + 2
        keeps.append(historyRect.insetBy(dx: -m, dy: -m))
        keeps.append(contentsOf: cornerRects)
        keeps.append(spectatorBadge(spectating: spectating))
        if !spectating {
            keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
            keeps.append(accessoryContent)
            keeps.append(bubbleRect(.bottom))
            keeps.append(bidBand)
        }
        if let f = chrome.fold, !foldIgnored { keeps.append(f) }
        return keeps
    }

    private func fanIsClear(_ r: CGRect, keeps: [CGRect]) -> Bool {
        let G = Self.fanGap
        guard r.minX >= safeRect.minX + G - 0.01, r.maxX <= safeRect.maxX - G + 0.01,
              r.minY >= safeRect.minY + chrome.bottomBar + G - 0.01, r.maxY <= topLimit + 0.01 else { return false }
        return !keeps.contains { Self.overlaps($0.insetBy(dx: -G, dy: -G), r) }
    }

    // MARK: dealer marker

    /// The dealer button's diameter.
    static let dealerChip: CGFloat = 18
    /// Its centre's distance from the avatar's: outside the pips' ring and the bore outline.
    static let dealerChipOffset: CGFloat = 39

    /// The dealer button on a seat with an avatar (scene coordinates): beside the avatar,
    /// inside the seat's footprint, on the first side that is clear of the corner buttons,
    /// the trick cards and every bid bubble (the left first: the top seat's bubble is on its right).
    func dealerChip(_ r: Positions.RelativePosition) -> CGRect {
        let a = seatAnchor(r)
        let d = Self.dealerChip
        let sides: [CGFloat] = r == .right ? [1, -1] : [-1, 1]
        let cands = sides.map { CGRect(x: a.x + $0 * Self.dealerChipOffset - d / 2, y: a.y - d / 2, width: d, height: d) }
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        keeps.append(contentsOf: [Positions.RelativePosition.top, .left, .right, .bottom].map(bubbleRect))
        keeps.append(contentsOf: cornerRects)
        return cands.first { c in
            c.minX >= safeRect.minX - 0.01 && c.maxX <= safeRect.maxX + 0.01 && !keeps.contains { Self.overlaps($0, c) }
        } ?? cands[0]
    }

    /// My own dealer button (seated: I have no avatar): at the left end of my `handCount`
    /// cards, in the band above the hand that only a lifted card enters.
    func myDealerChip(handCount: Int) -> CGRect {
        let d = Self.dealerChip
        let n = max(handCount, 0)
        let width = n > 0 ? Self.cardSize.width * handScale + handOverlap(count: n) * CGFloat(n - 1) : 0
        let x = max(safeRect.minX + 2, handBaseline.x - width / 2)
        let band = max(liftTop - handTop, d)
        return CGRect(x: x, y: handTop + (band - d) / 2, width: d, height: d)
    }
}
