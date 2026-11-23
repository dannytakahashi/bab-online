import CoreGraphics

/// The avatar badges (State/Table/SeatBadges.swift: the lightbulb, the graduation cap), placed
/// from the solved layout without changing it, like the dealer marker and the seat eye.
///
/// A badge is a small round chip (`seatBadge` across) in a corner beside the avatar, wholly
/// outside the circle the turn glow (30), the voice ring (28), the pips and the bore outline stay
/// inside (`badgeClear`, measured to the drawn disc: it is round), at the first spot
/// (`badgeCandidates`: on the circle `badgeClear + seatBadge / 2` round the avatar, the side away
/// from the seat's dealer marker first (the upper corner, then lower and higher on that side),
/// then the other side, then straight above) that keeps `badgeGap` off everything the seat eye
/// keeps off (`watchKeeps`: every seat's dealer marker, name, glow and bid bubble, the trick
/// cards, the fans, the corner buttons, the piles, the spectator badge, the banner, my seat's
/// row, my lifted hand and the bid panel, the fold) and off the seat eyes the table shows,
/// inside the safe area (`badgeEdge` from its sides) below the score bar and above the bottom
/// pill (`badgeProblems`); where none is, the spot covering least, never the avatar's rings, a
/// dealer marker, a bid bubble or an eye while a spot spares them (`badgeCost`). A chat bubble
/// (transient, above the table's nodes) may cover it for its few seconds, as it covers a fan.
/// Never on my own seat (no avatar: the render model has no such opponent); a watcher's
/// watched seat is the bottom hand, with no avatar either, so it has none.
extension TableLayout {
    /// The chip's diameter.
    static let seatBadge: CGFloat = 16
    /// The drawn disc's nearest point is at least this far from the avatar's centre (as the eye's
    /// `watchClear`: past the turn glow, the voice ring and the bore outline).
    static let badgeClear: CGFloat = 31
    /// The clear gap around it.
    static let badgeGap: CGFloat = 1
    /// Its least distance from the safe area's sides.
    static let badgeEdge: CGFloat = 4
    /// Where on its side it may sit, best first: degrees above the side's horizontal (45: the
    /// upper corner; the lower corners are the name's).
    static let badgeAngles: [CGFloat] = [45, 30, 60, 15, 75, 0, -15]

    /// The badge on a seat with an avatar (scene coordinates), clear of `eyes` (the seat eyes shown).
    func seatBadge(_ r: Positions.RelativePosition, spectating: Bool, eyes: [CGRect] = []) -> CGRect {
        let cands = badgeCandidates(r)
        let keeps = badgeKeeps(spectating: spectating, eyes: eyes)
        var best = cands[0], bestCost = Int.max
        for c in cands {
            let cost = badgeProblems(c, seat: r, keeps: keeps).reduce(0) { $0 + Self.badgeCost($1) }
            if cost == 0 { return c }
            if cost < bestCost { best = c; bestCost = cost }
        }
        return best
    }

    /// The badge of `o` on the table `model` shows (its seat eyes kept clear of).
    func seatBadge(_ o: TableRenderModel.Opponent, model: TableRenderModel) -> CGRect {
        seatBadge(o.rel, spectating: model.hand == nil, eyes: seatEyes(model))
    }

    /// The seat eyes `model` shows (TableLayout+Watchers.swift; none while nobody watches a hand).
    func seatEyes(_ model: TableRenderModel) -> [CGRect] {
        let bySeat = model.watching.watchersBySeat
        guard !bySeat.isEmpty else { return [] }
        return model.opponents.compactMap { o in
            guard let n = bySeat[o.position]?.count, n > 0 else { return nil }
            return watchChip(o.rel, count: n, spectating: model.hand == nil)
        }
    }

    /// Where it may go, best first.
    func badgeCandidates(_ r: Positions.RelativePosition) -> [CGRect] {
        let a = seatAnchor(r)
        let size = CGSize(width: Self.seatBadge, height: Self.seatBadge)
        let dist = Self.badgeClear + Self.seatBadge / 2
        // the side away from the dealer marker's (the spot it takes, whether or not the seat dealt)
        let dealerSide: CGFloat = dealerChip(r).midX < a.x ? -1 : 1
        var out: [CGRect] = []
        for side in [-dealerSide, dealerSide] {
            for deg in Self.badgeAngles {
                let t = deg * .pi / 180
                out.append(Self.rect(CGPoint(x: a.x + side * dist * cos(t), y: a.y + dist * sin(t)), size))
            }
        }
        out.append(Self.rect(CGPoint(x: a.x, y: a.y + dist), size))
        return out
    }

    /// What a badge keeps off: the eye's keeps and the eyes shown ("eye").
    func badgeKeeps(spectating: Bool, eyes: [CGRect]) -> [(String, CGRect)] {
        watchKeeps(spectating: spectating) + eyes.map { ("eye", $0) }
    }

    /// How bad covering `what` is: the avatar's rings, a dealer marker, a bid bubble and an eye far
    /// outweigh anything else.
    static func badgeCost(_ what: String) -> Int { what == "eye" ? 100 : watchCost(what) }

    /// What `chip` on seat `seat` covers or leaves ([] = a clear spot).
    func badgeProblems(_ chip: CGRect, seat: Positions.RelativePosition, keeps: [(String, CGRect)]) -> [String] {
        var out: [String] = []
        let E = Self.badgeEdge
        if chip.minX < safeRect.minX + E - 0.01 || chip.maxX > safeRect.maxX - E + 0.01 { out.append("safeArea") }
        if chip.maxY > topLimit + 0.01 { out.append("topBar") }
        if chip.minY < safeRect.minY + chrome.bottomBar - 0.01 { out.append("bottomBar") }
        // the disc against the seat's rings (circles: by distance)
        let a = seatAnchor(seat)
        if hypot(chip.midX - a.x, chip.midY - a.y) - chip.width / 2 < Self.badgeClear - 0.01 { out.append("avatar") }
        let G = Self.badgeGap
        for (what, k) in keeps where what != "glow.\(seat.rawValue)" {
            if Self.overlaps(k.insetBy(dx: -G, dy: -G), chip) { out.append(what) }
        }
        return out
    }
}
