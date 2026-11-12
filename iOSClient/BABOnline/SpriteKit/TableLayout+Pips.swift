import CoreGraphics

/// Trick pips (owner, 2026-11-11: per player; SeatPips), placed from the
/// solved layout without changing it.
///
/// - Every seat with an avatar (the three others; a spectator's four) draws its
///   pips as dots on a ring around the avatar (`seatPipRadius`), inside the
///   seat's 60 x 60 glow rect, so they need no room of their own.
/// - My own seat has no avatar (the hand is mine): my pips are a small box
///   (`myPipsSize`, two rows of up to 7) at `myPips`: where my bid bubble was
///   (left of my trick slot; the pips show once that bubble is gone), else
///   higher up beside my slot, under it, right of it above HSI / voice, else
///   the clear spot nearest the first. It keeps clear of the hand, HSI / voice,
///   the trick cards, the history (all 13 per row; 8 pt past its border), every seat (glow, name,
///   bid bubble) and the corner buttons. The bid band is exempt (the pips
///   hide while bidding). The spectator badge and its bubble keep clear of it.
extension TableLayout {
    /// The box for 13 pips: two rows of 7 dots (5 pt, 2 pt apart) with a 3 pt pad.
    static let myPipsSize = CGSize(width: 56, height: 20)
    /// The ring the seat pips sit on (avatar radius 20, glow radius 30).
    static let seatPipRadius: CGFloat = 25
    static let pipDot: CGFloat = 5
    static let pipGap: CGFloat = 2

    /// My pips' box in scene coordinates (seated); solved once per layout.
    var myPips: CGRect { myPipsRect }

    func computeMyPips() -> CGRect {
        let cands = myPipsCandidates()
        let soft = myPipsKeeps(soft: true)
        for c in cands where isClearForPips(c, keeps: soft) { return c }
        if let first = cands.first, let r = nearestClearPips(to: first, keeps: soft) { return r }
        let hard = myPipsKeeps(soft: false)
        for c in cands where isClearForPips(c, keeps: hard) { return c }
        if let first = cands.first, let r = nearestClearPips(to: first, keeps: hard) { return r }
        return cands.first ?? .zero
    }

    /// The clear gap between my pips' box and the trick piles (their drawn border included).
    static let myPipsPileGap: CGFloat = 8

    /// The trick piles grown by their border's pad, the gap and 2 pt for the strokes and their
    /// antialiasing (the pill's bore outline, the pile border; SpriteKit's frames include it):
    /// my pips' box stays outside it.
    var myPipsHistoryKeep: CGRect {
        let m = TrickHistoryNode.borderPad + Self.myPipsPileGap + 2
        return historyRect.insetBy(dx: -m, dy: -m)
    }

    /// What my pips must not cover. `soft: false` leaves out the other seats' bid bubbles
    /// (on screen only until the hand's first card).
    func myPipsKeeps(soft: Bool) -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        for r in [Positions.RelativePosition.top, .left, .right] {
            keeps.append(seatFootprint(r))
            if soft { keeps.append(bubbleRect(r)) }
        }
        keeps.append(myPipsHistoryKeep)
        keeps.append(contentsOf: cornerRects)
        keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
        keeps.append(accessoryContent)
        return keeps
    }

    private func myPipsCandidates() -> [CGRect] {
        let w = Self.myPipsSize.width, h = Self.myPipsSize.height, G = Self.gap
        let slot = trickRect(.bottom)
        let bubble = bubbleRect(.bottom)
        var out = [CGRect(x: bubble.maxX - w, y: bubble.midY - h / 2, width: w, height: h)]
        // up beside my slot, toward the left card
        var y = bubble.midY - h / 2 + 2
        while y + h <= slot.maxY {
            out.append(CGRect(x: slot.minX - G - w, y: y, width: w, height: h))
            y += 2
        }
        out.append(CGRect(x: slot.midX - w / 2, y: slot.minY - G - h, width: w, height: h))
        out.append(CGRect(x: slot.maxX + G, y: accessoryContent.maxY + G, width: w, height: h))
        return out
    }

    private func isClearForPips(_ r: CGRect, keeps: [CGRect]) -> Bool {
        guard r.minX >= safeRect.minX + Self.margin - 0.01, r.maxX <= safeRect.maxX - Self.margin + 0.01,
              r.minY >= safeRect.minY - 0.01, r.maxY <= topLimit + 0.01 else { return false }
        if let f = chrome.fold, !foldIgnored, f.intersects(r) { return false }
        return !keeps.contains { Self.overlaps($0, r) }
    }

    /// The clear spot nearest `first`, along both edges and `first`'s row and column (2 pt steps).
    private func nearestClearPips(to first: CGRect, keeps: [CGRect]) -> CGRect? {
        let w = Self.myPipsSize.width, h = Self.myPipsSize.height
        var best: CGRect?
        var bestD = CGFloat.infinity
        func consider(_ x: CGFloat, _ y: CGFloat) {
            let r = CGRect(x: x, y: y, width: w, height: h)
            let d = hypot(x - first.minX, y - first.minY)
            if d < bestD, isClearForPips(r, keeps: keeps) { best = r; bestD = d }
        }
        let top = min(safeRect.maxY, topLimit) - h
        let left = safeRect.minX + Self.margin, right = safeRect.maxX - Self.margin - w
        var y = safeRect.minY
        while y <= top {
            consider(left, y)
            consider(right, y)
            consider(first.minX, y)
            y += 2
        }
        var x = left
        while x <= right {
            consider(x, first.minY)
            x += 2
        }
        return best
    }

    /// The rows `n` box pips take: one row up to 7 (the box's width), else two balanced
    /// rows, the longer on top (8: 4 + 4, 9: 5 + 4, 13: 7 + 6).
    static func myPipRows(_ n: Int) -> [Int] {
        guard n > 0 else { return [] }
        return n <= 7 ? [n] : [(n + 1) / 2, n / 2]
    }

    /// Dot centers for `n` pips inside a box of `size` centred at the origin (myPipRows;
    /// each row centred; the box's own coordinates, y up).
    static func myPipDots(_ n: Int) -> [CGPoint] {
        let step = pipDot + pipGap
        let rows = myPipRows(n)
        let rowY: [CGFloat] = rows.count == 2 ? [step / 2, -step / 2] : [0]
        var out: [CGPoint] = []
        for (r, count) in rows.enumerated() {
            let width = CGFloat(count - 1) * step
            for i in 0..<count { out.append(CGPoint(x: -width / 2 + CGFloat(i) * step, y: rowY[r])) }
        }
        return out
    }

    /// The pill drawn around `n` dots (centred on the box): its size.
    static func myPipsPill(_ n: Int) -> CGSize {
        let step = pipDot + pipGap
        let rows = myPipRows(max(1, n))
        let cols = rows.max() ?? 1
        return CGSize(width: CGFloat(cols - 1) * step + pipDot + 6, height: CGFloat(rows.count - 1) * step + pipDot + 6)
    }

    /// The lowest point (seat-local, y up) any seat pip or the bore outline may reach:
    /// the seat's name starts below it. A name's ink reaches -24 (lowercase ascenders,
    /// capitals) and -20 at most (an accented capital, OpponentHandNode's 14 pt bold
    /// label at -36); the ring leaves 1 pt.
    static let seatPipFloor: CGFloat = -19
    /// The bore outline's radius (outside the dots) and stroke.
    static let seatBoreRadius: CGFloat = seatPipRadius + pipDot / 2 + 1.5
    static let seatBoreLine: CGFloat = 1.5
    /// The ring is a horseshoe open at the bottom, where the name is: the dots and the
    /// bore outline span this angle each side of the top (radians), so neither reaches
    /// below `seatPipFloor` (the outline's outer edge is the lower: 129 degrees).
    static let seatArcHalfSpan: CGFloat = {
        let outer = seatBoreRadius + seatBoreLine / 2
        let outline = acos(seatPipFloor / outer)
        let dots = acos((seatPipFloor + pipDot / 2) / seatPipRadius)
        return (min(outline, dots) * 180 / .pi).rounded(.down) * .pi / 180
    }()

    /// Dot centers on the seat ring for `n` pips (seat-local): along the horseshoe, centred
    /// on the top, 45 degrees apart or closer when that would pass its ends (filled
    /// clockwise from the left end, as a gauge).
    static func seatPipDots(_ n: Int) -> [CGPoint] {
        guard n > 0 else { return [] }
        let step = n > 1 ? min(CGFloat.pi / 4, 2 * seatArcHalfSpan / CGFloat(n - 1)) : 0
        return (0..<n).map { i in
            // clockwise from the top: x = r sin(a), y = r cos(a)
            let a = (CGFloat(i) - CGFloat(n - 1) / 2) * step
            return CGPoint(x: seatPipRadius * sin(a), y: seatPipRadius * cos(a))
        }
    }
}
