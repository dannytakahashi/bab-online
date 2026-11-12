import CoreGraphics

/// Trick pips (owner, 2026-11-11: per player; SeatPips), placed from the
/// solved layout without changing it.
///
/// - Every seat with an avatar (the three others; a spectator's four) draws its
///   pips as dots on a ring around the avatar (`seatPipRadius`), inside the
///   seat's 60 x 60 glow rect, so they need no room of their own.
/// - My own seat has no avatar (the hand is mine): my pips are a small box
///   (`myPipsSize`, two rows of up to 7) at `myPips`, the first item of my
///   seat's row just above my hand: my pips, HSI, the voice button (owner,
///   2026-11-12; TableLayout+SeatRow.swift).
extension TableLayout {
    /// The box for 13 pips: two rows of 7 dots (5 pt, 2 pt apart) with a 3 pt pad.
    static let myPipsSize = CGSize(width: 56, height: 20)
    /// The ring the seat pips sit on (avatar radius 20, glow radius 30).
    static let seatPipRadius: CGFloat = 25
    static let pipDot: CGFloat = 5
    static let pipGap: CGFloat = 2

    /// My pips' box in scene coordinates (seated): in my seat's row.
    var myPips: CGRect { seatRow.pips }

    /// The clear gap between my pips' box and the trick piles (their drawn border included).
    static let myPipsPileGap: CGFloat = 8

    /// Where my pips' node goes for a pill of `slots` (scene coordinates): the pill sits in
    /// its box against its neighbour (trailing beside HSI or the voice button, at the
    /// bottom over HSI), 1 pt in from the box's edge for the bore outline's stroke.
    func myPipsCenter(slots: Int) -> CGPoint {
        let box = myPips
        let pill = Self.myPipsPill(slots)
        let inset: CGFloat = 1
        switch seatRow.mode {
        case .row, .narrow:
            // HSI (a row) or the voice button (narrow) is to the right
            return CGPoint(x: box.maxX - inset - pill.width / 2, y: box.midY)
        case .compact, .stacked:
            // HSI is below
            return CGPoint(x: box.minX + inset + pill.width / 2, y: box.minY + inset + pill.height / 2)
        }
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
