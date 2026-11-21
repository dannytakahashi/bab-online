import CoreGraphics

/// The seat eye (the over-the-shoulder view's transparency, docs/claude/spectators.md "Who watches
/// which hand"; the web's `.hud-watch-chip`): a small pill with an eye, and the count past one, on
/// a seat whose hand somebody watches. Placed from the solved layout without changing it, like the
/// dealer marker.
///
/// On a seat with an avatar it sits in a corner beside the avatar, wholly outside the circle the
/// turn glow, the voice ring, the pips and the bore outline stay inside (`watchClear`), at the
/// first spot (`watchCandidates`: the dealer marker's side first, then the other, from just above
/// the dealer marker's row up, then centred above, then under the name) that keeps `watchGap` off
/// every seat's dealer marker, name, glow and bid bubble, the trick cards, the fans, the corner
/// buttons, the piles, the spectator badge, the banner, my seat's row, my lifted hand and the bid
/// panel, the fold, inside the safe area below the score bar and above the bottom pill
/// (`watchKeeps`); where none is, the spot covering least, never the avatar's rings, a dealer
/// marker or a bid bubble while a spot spares them (`watchCost`). My own seat has no avatar: mine
/// sits at the right end of my hand in the band a lifted card rises into, as my dealer marker
/// does at its left end (`myWatchChip`).
extension TableLayout {
    /// The pill's height, and its width with no count.
    static let watchChipHeight: CGFloat = 15
    static let watchChipMinWidth: CGFloat = 20
    /// Per character of the count ("2", "12", "99+").
    static let watchChipCharWidth: CGFloat = 6.5
    /// The chip's nearest point is at least this far from the avatar's centre: past the turn
    /// glow (30), the voice ring (28) and the bore outline.
    static let watchClear: CGFloat = 31
    /// The clear gap around it.
    static let watchGap: CGFloat = 1
    /// Its least distance from the safe area's sides.
    static let watchEdge: CGFloat = 4

    /// The pill's size for `count` watchers.
    static func watchChipSize(count: Int) -> CGSize {
        let chars = CGFloat(WatchingList.eyeCount(count)?.count ?? 0)
        return CGSize(width: watchChipMinWidth + (chars > 0 ? 2 + chars * watchChipCharWidth : 0), height: watchChipHeight)
    }

    /// The eye on a seat with an avatar (scene coordinates).
    func watchChip(_ r: Positions.RelativePosition, count: Int, spectating: Bool) -> CGRect {
        let cands = watchCandidates(r, count: count)
        let keeps = watchKeeps(spectating: spectating)
        // the first clear spot, else the one covering least: never the seat chips while any spot spares them
        var best = cands[0], bestCost = Int.max
        for c in cands {
            let cost = watchProblems(c, seat: r, keeps: keeps, spectating: spectating).reduce(0) { $0 + Self.watchCost($1) }
            if cost == 0 { return c }
            if cost < bestCost { best = c; bestCost = cost }
        }
        return best
    }

    /// Where it may go, best first.
    func watchCandidates(_ r: Positions.RelativePosition, count: Int) -> [CGRect] {
        let a = seatAnchor(r)
        let s = Self.watchChipSize(count: count)
        let R = Self.watchClear
        // the dealer marker's side first (away from the seat's bid bubble), then the other
        let sides: [CGFloat] = r == .right ? [1, -1] : [-1, 1]
        var out: [CGRect] = []
        // just above the dealer marker's row (its top is 9 above the centre), then higher: just
        // above the top seat's bid bubble beside it (where the score bar leaves no more room), higher
        let lifts: [CGFloat] = [Self.dealerChip / 2 + 1.5, 17, Self.bubbleSize.height / 2 + 1.5, 24]
        for lift in lifts {
            let inner = (R * R - lift * lift).squareRoot()
            for side in sides {
                let x = side > 0 ? a.x + inner : a.x - inner - s.width
                out.append(CGRect(x: x, y: a.y + lift, width: s.width, height: s.height))
            }
        }
        out.append(CGRect(x: a.x - s.width / 2, y: a.y + R, width: s.width, height: s.height))
        // under the name (the top seat right under the score bar, its fan beside it on the left
        // and its bid bubble on the right: no room by the avatar for a count)
        out.append(CGRect(x: a.x - s.width / 2, y: a.y + Self.nameLo - 1.5 - s.height, width: s.width, height: s.height))
        return out
    }

    /// What an eye on a seat with an avatar must keep off (its own seat's glow is a circle:
    /// `watchProblems` checks it by distance).
    func watchKeeps(spectating: Bool) -> [(String, CGRect)] {
        let all: [Positions.RelativePosition] = [.top, .left, .right, .bottom]
        let seats: [Positions.RelativePosition] = spectating ? all : [.top, .left, .right]
        var keeps: [(String, CGRect)] = all.map { ("trick.\($0.rawValue)", trickRect($0)) }
        for r in seats {
            let a = seatAnchor(r)
            keeps.append(("glow.\(r.rawValue)", Self.glowRect(a)))
            keeps.append(("name.\(r.rawValue)", Self.nameRect(a)))
            keeps.append(("dealer.\(r.rawValue)", dealerChip(r)))
            keeps.append(("bubble.\(r.rawValue)", bubbleRect(r)))
        }
        for (r, box) in fans(spectating: spectating) ?? [:] { keeps.append(("fan.\(r.rawValue)", box)) }
        let m = TrickHistoryNode.borderPad + 2
        keeps.append(("piles", historyRect.insetBy(dx: -m, dy: -m)))
        keeps.append(contentsOf: cornerRects.map { ("corner", $0) })
        keeps.append(("spectators", spectatorBadge(spectating: spectating)))
        if let banner = bannerRect(spectating: spectating) { keeps.append(("banner", banner)) }
        if !spectating {
            keeps.append(("hand", CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY))))
            keeps.append(("seatRow", accessoryContent))
            keeps.append(("bubble.bottom", bubbleRect(.bottom)))
            keeps.append(("bidPanel", bidBand))
        }
        if let f = chrome.fold, !foldIgnored { keeps.append(("fold", f)) }
        return keeps
    }

    /// How bad covering `what` is: the avatar's rings, a dealer marker and a bid bubble (the seat
    /// chips the eye must never cover) far outweigh anything else.
    static func watchCost(_ what: String) -> Int {
        what == "avatar" || what.hasPrefix("dealer.") || what.hasPrefix("bubble.") ? 100 : 1
    }

    /// What `chip` on seat `seat` covers or leaves ([] = a clear spot).
    func watchProblems(_ chip: CGRect, seat: Positions.RelativePosition, keeps: [(String, CGRect)], spectating: Bool) -> [String] {
        var out: [String] = []
        // a few points in from the screen's sides (flush with the edge it reads as cut off)
        let E = Self.watchEdge
        if chip.minX < safeRect.minX + E - 0.01 || chip.maxX > safeRect.maxX - E + 0.01 { out.append("safeArea") }
        if chip.maxY > topLimit + 0.01 { out.append("topBar") }
        if chip.minY < safeRect.minY + chrome.bottomBar - 0.01 { out.append("bottomBar") }
        let a = seatAnchor(seat)
        let nx = min(max(a.x, chip.minX), chip.maxX), ny = min(max(a.y, chip.minY), chip.maxY)
        if hypot(nx - a.x, ny - a.y) < Self.watchClear - 0.01 { out.append("avatar") }
        let G = Self.watchGap
        for (what, k) in keeps where what != "glow.\(seat.rawValue)" {
            if Self.overlaps(k.insetBy(dx: -G, dy: -G), chip) { out.append(what) }
        }
        return out
    }

    /// My own eye (seated: I have no avatar): at the right end of my `handCount` cards, in the
    /// band above the hand that only a lifted card enters, right of my dealer marker.
    func myWatchChip(handCount: Int, count: Int) -> CGRect {
        let s = Self.watchChipSize(count: count)
        let n = max(handCount, 0)
        let width = n > 0 ? Self.cardSize.width * handScale + handOverlap(count: n) * CGFloat(n - 1) : 0
        let dealer = myDealerChip(handCount: handCount)
        let x = max(min(handBaseline.x + width / 2, safeRect.maxX - 2) - s.width, dealer.maxX + 4)
        let band = max(liftTop - handTop, s.height)
        return CGRect(x: x, y: handTop + (band - s.height) / 2, width: s.width, height: s.height)
    }
}
