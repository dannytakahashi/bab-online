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
/// row, my lifted hand and the bid panel, the fold), inside the safe area (`badgeEdge` from its
/// sides) below the score bar and above the bottom pill (`badgeProblems`); where none is, the
/// spot covering least, never the avatar's rings, a dealer marker or a bid bubble while a spot
/// spares them, and rather under the disconnect banner than past the screen's room (`badgeCost`;
/// a phone or the Duo with the banner up may leave no other spot). A badge is placed from the layout alone; the seat eye, placed
/// after it, keeps off every badge shown (`watchChip(badges:)`: on a crowded seat the eye's
/// first spot is often the badge's only clear one, and the eye has spots a badge has not,
/// under the name). A chat bubble
/// (transient, above the table's nodes) may cover it for its few seconds, as it covers a fan.
/// Never on my own seat (no avatar: the render model has no such opponent). A watcher's watched
/// seat is the bottom hand, with no avatar on the felt: its badge is on the watching pill's
/// avatar (WatchingPill, SeatBadgeChip), not placed here.
extension TableLayout {
    /// The chip's diameter.
    static let seatBadge: CGFloat = 16
    /// The drawn disc's nearest point is at least this far from the avatar's centre (as the eye's
    /// `watchClear`: past the turn glow, the voice ring and the bore outline; 2 pt past the glow's
    /// 30, so the disc never touches the glow's soft edge on the seat whose turn it is).
    static let badgeClear: CGFloat = 32
    /// The clear gap around it.
    static let badgeGap: CGFloat = 1
    /// Its least distance from the safe area's sides.
    static let badgeEdge: CGFloat = 4
    /// Where on its side it may sit, best first: degrees above the side's horizontal (40: the
    /// upper corner, just under a fan above the avatar and, on the top seat, just inside its bid
    /// bubble; the lower corners are the name's).
    static let badgeAngles: [CGFloat] = [40, 45, 35, 30, 50, 55, 60, 20, 15, 70, 75, 0, -15]

    /// The badge on a seat with an avatar (scene coordinates).
    func seatBadge(_ r: Positions.RelativePosition, spectating: Bool) -> CGRect {
        let cands = badgeCandidates(r)
        let keeps = badgeKeeps(spectating: spectating)
        var best = cands[0], bestCost = Int.max
        for c in cands {
            let cost = badgeProblems(c, seat: r, keeps: keeps).reduce(0) { $0 + Self.badgeCost($1) }
            if cost == 0 { return c }
            if cost < bestCost { best = c; bestCost = cost }
        }
        return best
    }

    /// The badge of `o` on the table `model` shows.
    func seatBadge(_ o: TableRenderModel.Opponent, model: TableRenderModel) -> CGRect {
        seatBadge(o.rel, spectating: model.hand == nil)
    }

    /// Every badge `model` shows (scene coordinates): what the seat eyes keep off.
    func seatBadges(_ model: TableRenderModel) -> [CGRect] {
        model.opponents.compactMap { $0.badge == nil ? nil : seatBadge($0, model: model) }
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

    /// What a badge keeps off: the eye's keeps.
    func badgeKeeps(spectating: Bool) -> [(String, CGRect)] { watchKeeps(spectating: spectating) }

    /// How bad covering `what` is: the eye's costs (the rings, a dealer marker, a bid bubble far
    /// outweigh the rest), and leaving the screen's room (under the score bar, the pill, off the
    /// side) worse than anything on the felt: a disconnect banner over the seat may hide it for a
    /// while, the score bar would cut it.
    static func badgeCost(_ what: String) -> Int {
        what == "safeArea" || what == "topBar" || what == "bottomBar" ? 50 : watchCost(what)
    }

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
