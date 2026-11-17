import CoreGraphics

/// Opponent card backs and the dealer marker (iOS 1.2.2; the web's
/// OpponentManager.displayOpponentHands / displayDealerButton), placed from the
/// solved layout without changing it, like the pips, my seat's row and the
/// spectator badge.
///
/// Card backs: each other seat (a spectator's four) holds a fan of card backs,
/// one per card left in its hand, in a fixed box (`fanBox` times the table's
/// fan scale, sized for 13 cards, so nothing moves as cards are played). The
/// fans come in three sizes (`fanScales`: roomy, regular, compact) and the table
/// takes the largest at which every seat has a clear spot: above the avatar,
/// and for the top seat also beside it on the left (past the dealer marker, or
/// past the name band; the bid bubble is on its right) or, compact only, under
/// its name; compact only, a side seat's fan may also sit beside its avatar on
/// the table's side (past the glow, or past the dealer marker), where the
/// corner buttons leave no room above it (a 390 pt phone's spectator, whose
/// pill raises the side seats to the buttons' level; every SE-size screen).
/// Each seat's spots are tried in that order, so a table that had room before
/// keeps the same boxes. "Clear" is `fanGap`
/// from the trick cards, every seat's glow, name, dealer marker and bid bubble,
/// the other fans, the corner buttons, the trick piles, my seat's row, my
/// lifted hand, the fold, the spectator badge and the safe area's edges. Fans
/// are all or nothing: when some seat has no clear spot at any size, or the
/// layout is degraded, the table shows none (opponents are the lightweight
/// anchors of before; eb73520 removed the first build's full-size backs,
/// "Simplified opponents: removed card-back fans").
///
/// The disconnect / idle banner (`chrome.banner`) is not transient, so a fan
/// keeps off it too: while a banner shows, a fan under it moves to its seat's
/// next clear spot, or is left out until the banner goes (`fans`; the other
/// seats' fans stay where they are).
///
/// Transient things may cover a fan for a few seconds: a seat's chat bubble
/// (it opens above the seat), a rainbow.
///
/// Dealer marker: a small "D" button. On a seat with an avatar it sits beside
/// the avatar, inside the seat's footprint (glow + name band), which everything
/// else already keeps clear of, on the side away from the seat's bid bubble.
/// My own seat has no avatar: mine sits at the left end of my hand, in the band
/// a lifted card rises into (nothing else is ever placed there).
extension TableLayout {
    /// One card back of a fan at scale 1 (the card's 100 : 145).
    static let fanCard = CGSize(width: 26, height: 37.7)
    /// Between two backs.
    static let fanStep: CGFloat = 5
    /// The fan's turn per card, radians (the outer cards lean out).
    static let fanTurn: CGFloat = 0.04
    /// How much a card drops per squared point from the fan's centre.
    static let fanDrop: CGFloat = 0.0012
    /// The room a 13-card fan takes at scale 1 (its rotated cards included).
    static let fanBox = CGSize(width: 96, height: 46)
    /// The fan sizes, largest first: roomy (an iPad, where the table has space to spare),
    /// regular (the open Duo), compact (a phone: a 16 x 23 back, a 60 x 29 box).
    static let fanScales: [CGFloat] = [1.3, 1, 0.62]
    /// The clear gap around a fan.
    static let fanGap: CGFloat = 4
    static let fanMaxCards = 13

    /// A card back's place in its fan: centre (relative to the box's centre, y up) and rotation.
    struct FanSlot: Equatable {
        let center: CGPoint
        let rotation: CGFloat
    }

    /// Slots for `count` backs at scale 1, left to right (at most `fanMaxCards`): a pure function of the count.
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

    /// The scale a fan box was laid out at (its width against `fanBox`'s).
    static func fanScale(of box: CGRect) -> CGFloat { box.width / fanBox.width }

    /// The fans the table shows now (scene coordinates): `fanPlan`, minus any fan the
    /// banner covers and has no other clear spot for. Nil when the table shows no fans.
    func fans(spectating: Bool) -> [Positions.RelativePosition: CGRect]? {
        guard let plan = fanPlan(spectating: spectating) else { return nil }
        guard let banner = bannerRect(spectating: spectating) else { return plan }
        let G = Self.fanGap
        let hit = { (box: CGRect) in Self.overlaps(banner.insetBy(dx: -G, dy: -G), box) }
        guard plan.values.contains(where: hit) else { return plan }
        let scale = Self.fanScale(of: plan.values.first ?? CGRect(origin: .zero, size: Self.fanBox))
        let keeps = fanKeeps(spectating: spectating) + [banner]
        var out = plan.filter { !hit($0.value) }
        for r in Self.fanSeats(spectating) where out[r] == nil {
            if let box = fanCandidates(r, scale: scale).first(where: { c in
                fanIsClear(c, keeps: keeps) && !out.values.contains { Self.overlaps($0.insetBy(dx: -G, dy: -G), c) }
            }) { out[r] = box }
        }
        return out
    }

    /// Every seat's fan box (scene coordinates) with no banner up, at the largest scale that
    /// has room for all of them, or nil when the table has no room at any.
    func fanPlan(spectating: Bool) -> [Positions.RelativePosition: CGRect]? {
        guard !isDegraded, size.width > 0, size.height > 0 else { return nil }
        let keeps = fanKeeps(spectating: spectating)
        let seats = Self.fanSeats(spectating)
        for scale in Self.fanScales {
            let clear = seats.map { r in fanCandidates(r, scale: scale).filter { fanIsClear($0, keeps: keeps) } }
            if let boxes = Self.firstFit(clear, placed: []) {
                return Dictionary(uniqueKeysWithValues: zip(seats, boxes))
            }
        }
        return nil
    }

    /// One clear spot per seat, none touching another (`fanGap`), each seat's best spot first:
    /// a depth-first search, so a seat whose best spot takes the only spot a later seat has
    /// moves to its next one (the closed Duo with its vertical bar: the top seat's fan beside
    /// its avatar touched the left seat's, the only one it had, and the table showed none).
    private static func firstFit(_ spots: [[CGRect]], placed: [CGRect]) -> [CGRect]? {
        guard let mine = spots.first else { return placed }
        for c in mine where !placed.contains(where: { overlaps($0.insetBy(dx: -fanGap, dy: -fanGap), c) }) {
            if let all = firstFit(Array(spots.dropFirst()), placed: placed + [c]) { return all }
        }
        return nil
    }

    private static func fanSeats(_ spectating: Bool) -> [Positions.RelativePosition] {
        spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
    }

    /// Where a seat's fan may go at `scale`, best first.
    private func fanCandidates(_ r: Positions.RelativePosition, scale: CGFloat) -> [CGRect] {
        let a = seatAnchor(r)
        let b = CGSize(width: Self.fanBox.width * scale, height: Self.fanBox.height * scale)
        let above = CGRect(x: a.x - b.width / 2, y: a.y + Self.glowRadius + Self.gap, width: b.width, height: b.height)
        if r == .left || r == .right {
            guard scale < 1 else { return [above] }
            // a phone whose side seats sit level with the corner buttons (a spectator's pill
            // raises the seats; an SE-size screen always): the compact fan may sit beside the
            // avatar on the table's side, level with it, past the glow, else past the dealer marker
            let inward: CGFloat = r == .left ? 1 : -1
            let glow = a.x + inward * (Self.glowRadius + Self.gap)
            let chip = a.x + inward * (Self.dealerChipOffset + Self.dealerChip / 2 + Self.fanGap)
            return [above] + [glow, chip].map { edge in
                CGRect(x: inward > 0 ? edge : edge - b.width, y: a.y - b.height / 2, width: b.width, height: b.height)
            }
        }
        guard r == .top else { return [above] }
        // beside the avatar, level with it: past the dealer marker (above the name band), else
        // past the name band's edge
        let chip = a.x - Self.dealerChipOffset - Self.dealerChip / 2
        let beside = CGRect(x: chip - Self.fanGap - b.width, y: a.y - b.height / 2, width: b.width, height: b.height)
        let left = CGRect(x: a.x - Self.nameMaxWidth / 2 - Self.gap - b.width, y: a.y - b.height / 2, width: b.width, height: b.height)
        guard scale < 1 else { return [above, beside, left] }
        // a phone whose partner sits between the corner buttons has neither: the compact fan
        // may sit under the partner's name, well above the trick cards
        let below = CGRect(x: a.x - b.width / 2, y: a.y + Self.nameLo - Self.fanGap - b.height, width: b.width, height: b.height)
        return [above, beside, left, below]
    }

    /// What no fan may touch (the banner aside: `fans`).
    private func fanKeeps(spectating: Bool) -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        for r in Self.fanSeats(spectating) {
            let a = seatAnchor(r)
            // the seat's parts, not its footprint's bounding box: a compact fan sits in the
            // corner between the glow and the name band
            keeps.append(Self.glowRect(a))
            keeps.append(Self.nameRect(a))
            keeps.append(dealerChip(r))
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
