import Foundation
import CoreGraphics

/// Cut for a buck's ring (spec section 6, "Ring geometry"), the web's client/src/ui/cut/ringLayout.js
/// ported number for number, pure and unit-tested (`CutRingTests`: n 2..20 on every device's stage,
/// no overlaps, in bounds, me at 6 o'clock):
///   - the players in participants order, rotated so I sit at 6 o'clock, then clockwise
///     (`CutOrder.ring`); positions never change during the cut
///   - seats at equal arc length on the ellipse (its perimeter by Ramanujan's second formula, the
///     arc itself sampled)
///   - avatar d = clamp(0.45 x spacing, 32, 64), card w = clamp(0.42 x spacing, 30, maxCardW); when
///     that would overlap (many players on a small stage) everything shrinks together until it fits:
///     the ring is "compressed", never overlapping
///   - the name under the avatar; the cards on the inward ray, never rotated, with room for the
///     older cards' offsets (up to 3; from 13 players a thin stack edge)
///   - the deck in the middle, at least a 44 pt target
/// Every number is in points of the stage (0, 0 at its top left).
enum CutRing {
    static let cardRatio: CGFloat = 435.0 / 300.0
    static let avatarMin: CGFloat = 32
    static let avatarMax: CGFloat = 64
    static let cardMin: CGFloat = 30
    static let cardMax: CGFloat = 72
    /// The deck's least size (a 44 pt hit target).
    static let deckMin: CGFloat = 44
    /// Older cards behind the newest, as a share of the card width (up to 12 players).
    static let stackOffset: CGFloat = 0.16
    /// From this many players the older cards are a thin stack edge (pt each).
    static let denseFrom = 13
    static let denseEdge: CGFloat = 3
    /// Older cards drawn per player; the rest are the "+n" chip.
    static let stackShown = 3

    struct Seat: Equatable {
        let order: Int
        let angle: CGFloat
        /// The avatar's centre.
        let x: CGFloat
        let y: CGFloat
        let avatar: CGRect
        let name: CGRect
        /// The newest card; the older ones sit to its left (`stackW`).
        let card: CGRect
        let stack: CGRect
    }

    struct Layout: Equatable {
        var ok: Bool
        var why: String?
        var w: CGFloat, h: CGFloat
        var n: Int
        var f: CGFloat
        var cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat
        var spacing: CGFloat
        var avatarD: CGFloat
        var cardW: CGFloat, cardH: CGFloat
        var nameW: CGFloat, nameH: CGFloat
        var stackW: CGFloat
        var dense: Bool
        var seats: [Seat]
        var deck: CGRect
    }

    private static func clamp(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { min(hi, max(lo, v)) }

    /// Ramanujan's second approximation of an ellipse's perimeter.
    static func ellipsePerimeter(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        if a <= 0 || b <= 0 { return 4 * max(a, b, 0) }
        let h = pow((a - b) / (a + b), 2)
        return .pi * (a + b) * (1 + (3 * h) / (10 + (4 - 3 * h).squareRoot()))
    }

    /// Angles (screen radians: x = cx + rx cos t, y = cy + ry sin t, y down) of n points at equal arc
    /// length, the first at the bottom (t = pi / 2), then clockwise on screen.
    static func equalArcAngles(_ rx: CGFloat, _ ry: CGFloat, _ n: Int) -> [CGFloat] {
        guard n > 0 else { return [] }
        let steps = 720
        let start = CGFloat.pi / 2
        var cum: [CGFloat] = [0]
        cum.reserveCapacity(steps + 1)
        var px = rx * cos(start), py = ry * sin(start)
        for i in 1...steps {
            let t = start + 2 * .pi * CGFloat(i) / CGFloat(steps)
            let x = rx * cos(t), y = ry * sin(t)
            cum.append(cum[i - 1] + hypot(x - px, y - py))
            px = x
            py = y
        }
        let total = cum[steps]
        var out: [CGFloat] = []
        var j = 0
        for k in 0..<n {
            let target = total * CGFloat(k) / CGFloat(n)
            while j < steps && cum[j + 1] < target { j += 1 }
            let seg = cum[j + 1] - cum[j]
            let f = (target - cum[j]) / (seg == 0 ? 1 : seg)
            out.append(start + 2 * .pi * (CGFloat(j) + f) / CGFloat(steps))
        }
        return out
    }

    /// Axis-aligned rects overlap (touching edges do not).
    static func overlap(_ a: CGRect, _ b: CGRect, eps: CGFloat = 0.01) -> Bool {
        a.maxX - eps > b.minX && b.maxX - eps > a.minX && a.maxY - eps > b.minY && b.maxY - eps > a.minY
    }

    /// The room the older cards take beside the newest (the stack's width).
    static func stackAllowance(_ n: Int, _ cardW: CGFloat) -> CGFloat {
        n >= denseFrom ? denseEdge * CGFloat(stackShown) : stackOffset * cardW * CGFloat(stackShown)
    }

    /// One try at a size factor f (1: the spec's clamps; below 1: compressed); `ok` false when
    /// anything overlaps or spills.
    static func solve(w: CGFloat, h: CGFloat, n: Int, nameH: CGFloat, maxCardW: CGFloat, f: CGFloat) -> Layout {
        let pad: CGFloat = 4
        let gap = max(3, 6 * f)
        var d = avatarMax * f
        var cw = min(maxCardW, cardMax) * f
        var nameW = max(d, 64)
        var rx: CGFloat = 0, ry: CGFloat = 0, cx = w / 2, cy = h / 2, spacing: CGFloat = 0
        for _ in 0..<6 {
            let padX = max(d / 2, nameW / 2) + pad
            let padTop = d / 2 + pad
            let padBottom = d / 2 + 2 + nameH + pad
            rx = max(1, w / 2 - padX)
            ry = max(1, (h - padTop - padBottom) / 2)
            // a ring, not a flat band: the long axis at most 1.7 x the short
            rx = min(rx, ry * 1.7)
            ry = min(ry, rx * 1.35)
            cx = w / 2
            cy = padTop + (h - padTop - padBottom) / 2
            spacing = ellipsePerimeter(rx, ry) / CGFloat(max(1, n))
            d = clamp(0.45 * spacing, avatarMin, avatarMax) * f
            cw = clamp(0.42 * spacing, cardMin, min(maxCardW, cardMax)) * f
            // names are truncated with an ellipsis: wide enough for about 9 letters
            nameW = max(d, min(spacing - 8, max(d + 16, 76)))
        }
        let ch = cw * cardRatio
        let stackW = stackAllowance(n, cw)
        let seats: [Seat] = equalArcAngles(rx, ry, n).enumerated().map { order, t in
            let x = cx + rx * cos(t), y = cy + ry * sin(t)
            var ux = cx - x, uy = cy - y
            let len = hypot(ux, uy) == 0 ? 1 : hypot(ux, uy)
            ux /= len
            uy /= len
            let avatar = CGRect(x: x - d / 2, y: y - d / 2, width: d, height: d)
            let name = CGRect(x: x - nameW / 2, y: y + d / 2 + 2, width: nameW, height: nameH)
            func stackAt(_ px: CGFloat, _ py: CGFloat) -> CGRect {
                CGRect(x: px - (cw + stackW) / 2, y: py - ch / 2, width: cw + stackW, height: ch)
            }
            let own = [avatar.insetBy(dx: -gap, dy: -gap), name.insetBy(dx: -gap, dy: -gap)]
            var dist: CGFloat = 0
            while dist < len && own.contains(where: { overlap(stackAt(x + ux * dist, y + uy * dist), $0) }) { dist += 1 }
            let stack = stackAt(x + ux * dist, y + uy * dist)
            return Seat(order: order, angle: t, x: x, y: y, avatar: avatar, name: name,
                        card: CGRect(x: stack.minX + stackW, y: stack.minY, width: cw, height: ch), stack: stack)
        }

        // the deck: the biggest box near the centre that touches no card and no seat (a fan is wider
        // than tall: 2 : 1, down to square when that gives more room)
        let blockers = seats.flatMap { [$0.stack, $0.avatar, $0.name] }
        func fits(_ box: CGRect) -> Bool { !blockers.contains { overlap(box, $0) } }
        let cap = max(deckMin, ch * 2.1)
        var deck = CGRect(x: cx, y: cy, width: 0, height: 0)
        var shifts: [CGFloat] = [0]
        for k in 1...8 { shifts += [CGFloat(k) / 8 * ry * 0.45, -CGFloat(k) / 8 * ry * 0.45] }
        for dy in shifts {
            for aspect: CGFloat in [2, 1.7, 1.35, 1] {
                func boxAt(_ k: CGFloat) -> CGRect { CGRect(x: cx - aspect * k / 2, y: cy + dy - k / 2, width: aspect * k, height: k) }
                var lo: CGFloat = 0, hi = min(rx, ry) * 2
                for _ in 0..<22 {
                    let mid = (lo + hi) / 2
                    if fits(boxAt(mid)) { lo = mid } else { hi = mid }
                }
                let box = boxAt(min(lo, cap))
                let better = box.width * box.height > deck.width * deck.height * (dy == 0 ? 1 : 1.15) + 0.5
                if box.height >= deckMin - 0.01 && better { deck = box }
            }
            if deck.height >= cap - 0.01 { break }
        }
        if deck.width == 0 { deck = CGRect(x: cx - deckMin / 2, y: cy - deckMin / 2, width: 0, height: 0) }

        var why: String? = deck.height >= deckMin - 0.01 && deck.width >= deckMin - 0.01 ? nil : "deck"
        func inBounds(_ r: CGRect) -> Bool { r.minX >= -0.01 && r.minY >= -0.01 && r.maxX <= w + 0.01 && r.maxY <= h + 0.01 }
        var i = 0
        while why == nil && i < seats.count {
            let a = seats[i]
            if !inBounds(a.avatar) || !inBounds(a.name) || !inBounds(a.stack) { why = "bounds \(i)" }
            else if overlap(a.stack, a.avatar) || overlap(a.stack, a.name) { why = "own \(i)" }
            var j = i + 1
            while why == nil && j < seats.count {
                let b = seats[j]
                if overlap(a.avatar, b.avatar) || overlap(a.avatar, b.name) || overlap(a.name, b.avatar) || overlap(a.name, b.name) {
                    why = "seats \(i) \(j)"
                } else if overlap(a.stack, b.stack) {
                    why = "cards \(i) \(j)"
                } else if overlap(a.stack, b.avatar) || overlap(a.stack, b.name) || overlap(b.stack, a.avatar) || overlap(b.stack, a.name) {
                    why = "card-seat \(i) \(j)"
                }
                j += 1
            }
            i += 1
        }
        return Layout(ok: why == nil, why: why, w: w, h: h, n: n, f: f, cx: cx, cy: cy, rx: rx, ry: ry, spacing: spacing,
                      avatarD: d, cardW: cw, cardH: ch, nameW: nameW, nameH: nameH, stackW: stackW, dense: n >= denseFrom,
                      seats: seats, deck: deck)
    }

    /// The ring for n players on a w x h stage; seats[k] is ring position k (0: 6 o'clock, then
    /// clockwise). `nameH`: the name line plus its caption line.
    static func layout(w: CGFloat, h: CGFloat, n: Int, nameH: CGFloat = 30, maxCardW: CGFloat = cardMax) -> Layout {
        let count = max(0, n)
        let W = max(1, w), H = max(1, h)
        // the cards stay in proportion to the stage
        let cardCap = min(maxCardW, max(cardMin, min(W, H) * 0.14))
        let best = solve(w: W, h: H, n: count, nameH: nameH, maxCardW: cardCap, f: 1)
        if best.ok || count == 0 { return best }
        // shrink together until it fits: the largest size factor that does (a scan: the deck's floor
        // makes "fits" not monotonic)
        var f: CGFloat = 0.975
        while f >= 0.2 {
            let tryIt = solve(w: W, h: H, n: count, nameH: max(11, (nameH * min(1, f + 0.2)).rounded()), maxCardW: cardCap, f: f)
            if tryIt.ok { return tryIt }
            f -= 0.025
        }
        return solve(w: W, h: H, n: count, nameH: 11, maxCardW: cardCap, f: 0.2)
    }
}

/// The deck's face-down fan (the web's fanGeometry / fanAngle / fanIndexAt): the cards rotate about
/// the pivot (their bottom centre), spread evenly from -half to +half; it narrows as the deck
/// empties (+-50 degrees at a full deck).
struct CutFan: Equatable {
    static let fullHalfDegrees: CGFloat = 50
    static let lift: CGFloat = 0.12

    let half: CGFloat
    let cardH: CGFloat
    let cardW: CGFloat
    let pivot: CGPoint

    init(width w: CGFloat, height h: CGFloat, count: Int, deckSize: Int) {
        let share = deckSize > 0 ? min(1, CGFloat(count) / CGFloat(deckSize)) : 0
        half = count <= 1 ? 0 : max(4, Self.fullHalfDegrees * share) * .pi / 180
        let dip = sin(half) / CutRing.cardRatio / 2
        var ch = h * 0.97 / (1 + Self.lift + dip)
        let half = self.half
        func widthOf(_ c: CGFloat) -> CGFloat { 2 * (c * sin(half) + c / CutRing.cardRatio / 2 * cos(half)) }
        if widthOf(ch) > w * 0.96 { ch = w * 0.96 / (widthOf(1) == 0 ? 1 : widthOf(1)) }
        cardH = ch
        cardW = ch / CutRing.cardRatio
        pivot = CGPoint(x: w / 2, y: h * 0.03 + ch * (1 + Self.lift))
    }

    /// The angle of free card i of n.
    func angle(_ i: Int, of n: Int) -> CGFloat {
        n <= 1 ? 0 : -half + 2 * half * CGFloat(i) / CGFloat(n - 1)
    }

    /// The free card nearest a point in the fan's box.
    func index(at p: CGPoint, of n: Int) -> Int {
        if n <= 0 { return -1 }
        if n == 1 || half == 0 { return n == 1 ? 0 : n / 2 }
        let a = atan2(p.x - pivot.x, pivot.y - p.y)
        let i = Int((((a + half) / (2 * half)) * CGFloat(n - 1)).rounded())
        return max(0, min(n - 1, i))
    }

    /// The centre of free card i (lifted when it peeks), for a draw's flight.
    func centre(_ i: Int, of n: Int) -> CGPoint {
        let a = angle(i, of: n)
        let r = cardH * (0.5 + Self.lift)
        return CGPoint(x: pivot.x + sin(a) * r, y: pivot.y - cos(a) * r)
    }
}
