import CoreGraphics

/// Safe-area insets of the table pane, in points.
struct TableInsets: Equatable {
    var top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat
    static let zero = TableInsets(top: 0, left: 0, bottom: 0, right: 0)
}

/// Every non-size input of the table layout, measured by GameContainerView
/// (zero in tests unless a test sets it).
struct TableChrome: Equatable {
    /// Insets of the SpriteView's pane.
    var safeArea: TableInsets = .zero
    /// Measured ScoreBar height (0 when hidden).
    var topBar: CGFloat = 0
    /// max(Leave, Log) measured size: an obstacle at both top corners, below the top bar.
    var cornerButton: CGSize = .zero
    /// Lazy / spectator pill height + 12 padding; 0 when hidden.
    var bottomBar: CGFloat = 0
    /// The active fold (division) region in scene coordinates (item 27); nil when none.
    var fold: CGRect? = nil
    /// System occlusions in scene coordinates (empty unless measured on a device).
    var occlusions: [CGRect] = []
}

/// The table's layout: a pure function of the scene size and the chrome
/// (safe area, ScoreBar height, corner buttons, bottom pill, fold) that
/// places every seat, trick card, the hand, the history, the bid band and the
/// SwiftUI accessories so none of them intersect (roadmap item 25).
///
/// Scene coordinates: origin at the center, y up. The algorithm is the
/// reference model `layout_ref.py` (see docs/ios-table-store.md, "Table
/// layout"): it searches the hand scale s (1.0 ... 0.80) and the trick scale k
/// (1.0 ... 0.70) for the first pair that fits; the bottom pill is honoured
/// first and dropped only when nothing fits with it.
struct TableLayout: Equatable {
    enum SeatMode: Equatable { case row, raised }

    // MARK: constants (points)
    static let gap: CGFloat = 6                // G
    static let margin: CGFloat = 8             // M
    static let cardSize = CGSize(width: 100, height: 145)
    static let lift: CGFloat = 20
    static let trickBase: CGFloat = 0.8
    static let bidBandSize = CGSize(width: 340, height: 140)
    static let glowRadius: CGFloat = 30
    static let nameMaxWidth: CGFloat = 96
    static let nameLo: CGFloat = -39, nameHi: CGFloat = -26   // name label band below the seat anchor
    static let bubbleSize = CGSize(width: 60, height: 36)
    static let sideBubbleDY: CGFloat = -66
    static let topBubbleDX: CGFloat = 70
    static let historyHeight: CGFloat = 46
    static let historyIcon = CGSize(width: 12, height: 16)
    static let rainbowSize = CGSize(width: 128, height: 118)
    static let overTrumpSize: CGFloat = 120
    static let accessoryRow = CGSize(width: 124, height: 48)      // HStack minimum (HSI + voice)
    static let accessoryStack = CGSize(width: 84, height: 76)     // VStack minimum

    // MARK: outputs
    let size: CGSize
    let chrome: TableChrome
    /// Hand scale s in {1.0, 0.95 ... 0.80}, never above 1.
    let handScale: CGFloat
    /// Trick scale k in {1.0 ... 0.70}: a trick card is 80k x 116k.
    let trickScale: CGFloat
    let mode: SeatMode
    /// Nothing fit: s = 0.8, k = 0.7, positions clamped into the safe rect.
    let isDegraded: Bool
    /// The bottom bar the solve honoured (0 when the pill had to overlay the hand).
    let usedBottomBar: CGFloat
    let safeRect: CGRect
    /// Nothing but the corner buttons may reach above this line.
    let topLimit: CGFloat
    /// Leave (left) and Log (right) obstacles, occlusions merged in.
    let cornerRects: [CGRect]
    let handBaseline: CGPoint
    let handTop: CGFloat
    let liftTop: CGFloat
    let trickCardSize: CGSize
    let historyOrigin: CGPoint
    let historySpacing: CGFloat
    let boreBadgeCenter: CGPoint
    let overTrumpCenter: CGPoint
    /// Where the SwiftUI bid panel goes (reserved even while it is hidden).
    let bidBand: CGRect
    /// HSI + voice button rect (Q3, right of my trick slot).
    let accessory: CGRect

    private let tcx: CGFloat, cc: CGFloat, ox: CGFloat, oy: CGFloat
    private let yP: CGFloat, yS: CGFloat, lx: CGFloat, rx: CGFloat, yLo: CGFloat

    var trickSpriteScale: CGFloat { Self.trickBase * trickScale }
    var accessoryStacked: Bool { accessory.width < Self.accessoryRow.width - 0.01 }
    var bidPanelBottomInset: CGFloat { bidBand.minY + size.height / 2 }
    var chatMaxWidth: CGFloat { min(260, safeRect.width - 16) }

    // MARK: init

    init(size: CGSize, chrome: TableChrome = .init()) {
        self.size = size
        self.chrome = chrome
        let bars: [CGFloat] = chrome.bottomBar > 0 ? [chrome.bottomBar, 0] : [chrome.bottomBar]
        var found: Solution?
        search: for bar in bars {
            for si in 0..<5 {
                let s = 1.0 - 0.05 * CGFloat(si)
                if let sol = Self.solve(size: size, chrome: chrome, s: s, bottomBar: bar, strict: true) {
                    found = sol
                    break search
                }
            }
        }
        let degraded = found == nil
        let sol = found ?? Self.solve(size: size, chrome: chrome, s: 0.8, bottomBar: 0, strict: false)!
        self.isDegraded = degraded
        handScale = sol.s; trickScale = sol.k; mode = sol.mode; usedBottomBar = sol.bottomBar
        safeRect = sol.safe; topLimit = sol.topLimit; cornerRects = sol.corners
        handBaseline = sol.handBaseline; handTop = sol.handTop; liftTop = sol.liftTop
        trickCardSize = CGSize(width: 80 * sol.k, height: 116 * sol.k)
        tcx = sol.tcx; cc = sol.cc; ox = sol.ox; oy = sol.oy
        yP = sol.yP; yS = sol.yS; lx = sol.lx; rx = sol.rx; yLo = sol.yLo
        bidBand = sol.bid
        accessory = sol.accessory
        historyOrigin = sol.historyOrigin
        historySpacing = sol.historySpacing
        boreBadgeCenter = CGPoint(x: sol.tcx, y: sol.cc)
        let half = Self.overTrumpSize / 2
        overTrumpCenter = Self.clamp(CGPoint(x: sol.tcx - 40 * sol.k - Self.gap - half, y: sol.cc + 58 * sol.k + Self.gap + half),
                                     size: CGSize(width: Self.overTrumpSize, height: Self.overTrumpSize), into: sol.safe, top: sol.topLimit)
    }

    // MARK: hand

    /// Scene-units step between hand cards: min(35s, (safe.width - 16 - 100s) / (n - 1)).
    func handOverlap(count n: Int) -> CGFloat {
        guard n > 1 else { return 0 }
        let s = handScale
        return min(35 * s, (safeRect.width - 2 * Self.margin - Self.cardSize.width * s) / CGFloat(n - 1))
    }

    /// Card centers in the hand node's LOCAL (unscaled) units, left to right, y == 0.
    func handSlots(count: Int) -> [CGPoint] {
        guard count > 0 else { return [] }
        let step = handOverlap(count: count) / handScale
        let total = Self.cardSize.width + step * CGFloat(count - 1)
        let startX = -total / 2 + Self.cardSize.width / 2
        return (0..<count).map { CGPoint(x: startX + CGFloat($0) * step, y: 0) }
    }

    // MARK: trick

    /// Resting place of a seat's trick card (scene coordinates; the trick layer stays at the origin).
    func trickSlot(_ r: Positions.RelativePosition) -> CGPoint {
        switch r {
        case .bottom: return CGPoint(x: tcx, y: cc - oy)
        case .top: return CGPoint(x: tcx, y: cc + oy)
        case .left: return CGPoint(x: tcx - ox, y: cc)
        case .right: return CGPoint(x: tcx + ox, y: cc)
        }
    }

    func trickRect(_ r: Positions.RelativePosition) -> CGRect { Self.rect(trickSlot(r), trickCardSize) }

    /// Where a played card flies in from: off-screen on the seat's side.
    func trickEntry(_ r: Positions.RelativePosition) -> CGPoint {
        let tw = trickCardSize.width, th = trickCardSize.height
        switch r {
        case .top: return CGPoint(x: tcx, y: size.height / 2 + th)
        case .left: return CGPoint(x: -size.width / 2 - tw, y: yS)
        case .right: return CGPoint(x: size.width / 2 + tw, y: yS)
        case .bottom: return CGPoint(x: tcx, y: -size.height / 2 - th)
        }
    }

    /// Where a collected trick goes: the winner's seat.
    func collectPoint(_ r: Positions.RelativePosition) -> CGPoint { seatAnchor(r) }

    // MARK: seats

    /// Avatar center of a seat (the bottom seat, a spectator's view of seat 1..4, sits on the hand baseline).
    func seatAnchor(_ r: Positions.RelativePosition) -> CGPoint {
        switch r {
        case .top: return CGPoint(x: tcx, y: yP)
        case .left: return CGPoint(x: lx, y: yS)
        case .right: return CGPoint(x: rx, y: yS)
        case .bottom:
            // a spectator's seat 1..4 sits on the hand baseline, its name kept clear of the bottom pill
            return CGPoint(x: handBaseline.x, y: max(handBaseline.y, safeRect.minY + chrome.bottomBar - Self.nameLo + 1))
        }
    }

    /// Glow (60x60) plus the name band (96 wide, 13 tall, 26...39 below the anchor).
    func seatFootprint(_ r: Positions.RelativePosition) -> CGRect {
        let a = seatAnchor(r)
        return Self.glowRect(a).union(Self.nameRect(a))
    }

    /// Bid bubble center: beside the top seat, below the side seats' names, mine left of my trick slot (Q2).
    func bubbleAnchor(_ r: Positions.RelativePosition) -> CGPoint {
        let a = seatAnchor(r)
        switch r {
        case .top: return CGPoint(x: a.x + Self.topBubbleDX, y: a.y)
        case .left, .right: return CGPoint(x: a.x, y: a.y + Self.sideBubbleDY)
        case .bottom:
            let slot = trickRect(.bottom)
            return CGPoint(x: slot.minX - Self.gap - Self.bubbleSize.width / 2, y: slot.minY + Self.bubbleSize.height / 2)
        }
    }

    func bubbleRect(_ r: Positions.RelativePosition) -> CGRect { Self.rect(bubbleAnchor(r), Self.bubbleSize) }

    // MARK: chat

    /// Chat bubble center: above the seat, else below it (side seats: below the bid bubble), clamped into the safe rect.
    func chatPosition(_ r: Positions.RelativePosition, bubbleSize: CGSize) -> CGPoint {
        let w = bubbleSize.width, h = bubbleSize.height
        let a = seatAnchor(r)
        let foot = seatFootprint(r)
        let belowTop: CGFloat
        switch r {
        case .left, .right: belowTop = bubbleRect(r).minY - Self.gap
        default: belowTop = foot.minY - Self.gap
        }
        let lo = safeRect.minX + Self.margin + w / 2, hi = safeRect.maxX - Self.margin - w / 2
        let x = lo <= hi ? min(max(a.x, lo), hi) : safeRect.midX
        let above = CGPoint(x: x, y: foot.maxY + Self.gap + h / 2)
        let below = CGPoint(x: x, y: belowTop - h / 2)
        for c in [above, below] {
            let rr = Self.rect(c, bubbleSize)
            if rr.maxY <= topLimit + 0.01, rr.minY >= liftTop + Self.gap - 0.01, rr.minY >= safeRect.minY - 0.01,
               !cornerRects.contains(where: { $0.intersects(rr) }) {
                return c
            }
        }
        let ylo = safeRect.minY + h / 2, yhi = topLimit - h / 2
        return CGPoint(x: x, y: ylo <= yhi ? min(max(above.y, ylo), yhi) : (ylo + yhi) / 2)
    }

    // MARK: effects

    /// Rainbow center: the seat, clamped into the safe rect below topLimit (mine above my lifted hand).
    func rainbowCenter(_ r: Positions.RelativePosition) -> CGPoint {
        let p = r == .bottom ? CGPoint(x: tcx, y: liftTop + Self.gap + Self.rainbowSize.height / 2) : seatAnchor(r)
        return Self.clamp(p, size: Self.rainbowSize, into: safeRect, top: topLimit)
    }

    // MARK: SwiftUI

    /// A scene rect in the full pane's top-left coordinates (SwiftUI).
    func window(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX + size.width / 2, y: size.height / 2 - r.maxY, width: r.width, height: r.height)
    }

    // MARK: - geometry helpers

    static func rect(_ c: CGPoint, _ s: CGSize) -> CGRect {
        CGRect(x: c.x - s.width / 2, y: c.y - s.height / 2, width: s.width, height: s.height)
    }
    static func glowRect(_ a: CGPoint) -> CGRect { rect(a, CGSize(width: 2 * glowRadius, height: 2 * glowRadius)) }
    static func nameRect(_ a: CGPoint) -> CGRect {
        CGRect(x: a.x - nameMaxWidth / 2, y: a.y + nameLo, width: nameMaxWidth, height: nameHi - nameLo)
    }

    private static func clamp(_ p: CGPoint, size s: CGSize, into safe: CGRect, top: CGFloat) -> CGPoint {
        func c(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { lo <= hi ? min(max(v, lo), hi) : (lo + hi) / 2 }
        return CGPoint(x: c(p.x, safe.minX + s.width / 2, safe.maxX - s.width / 2),
                       y: c(p.y, safe.minY + s.height / 2, min(safe.maxY, top) - s.height / 2))
    }

    /// x-overlap (the reference model's `xover`).
    private static func xover(_ a: CGRect, _ b: CGRect) -> Bool { min(a.maxX, b.maxX) - max(a.minX, b.minX) > 0.01 }

    // MARK: - solve (layout_ref.py `layout_s`, one s, every k)

    private struct Solution {
        var s: CGFloat, k: CGFloat, mode: SeatMode, bottomBar: CGFloat
        var safe: CGRect, topLimit: CGFloat, corners: [CGRect]
        var handBaseline: CGPoint, handTop: CGFloat, liftTop: CGFloat
        var tcx: CGFloat, cc: CGFloat, ox: CGFloat, oy: CGFloat
        var yP: CGFloat, yS: CGFloat, lx: CGFloat, rx: CGFloat, yLo: CGFloat
        var bid: CGRect, accessory: CGRect, historyOrigin: CGPoint, historySpacing: CGFloat
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    private static func solve(size: CGSize, chrome: TableChrome, s: CGFloat, bottomBar P: CGFloat, strict: Bool) -> Solution? {
        let G = gap, M = margin
        let ins = chrome.safeArea
        let x0 = -size.width / 2 + ins.left, x1 = size.width / 2 - ins.right
        let y0 = -size.height / 2 + ins.bottom, y1 = size.height / 2 - ins.top
        let safe = CGRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
        let safeW = x1 - x0
        let cx = (x0 + x1) / 2
        let S = chrome.topBar
        let topLimit = y1 - S - G
        let bw = chrome.cornerButton.width, bh = chrome.cornerButton.height
        let cornerBottom = y1 - S - 8 - bh - G
        var cornerL = CGRect(x: x0, y: cornerBottom, width: 12 + bw + G, height: (y1 - S) - cornerBottom)
        var cornerR = CGRect(x: x1 - 12 - bw - G, y: cornerBottom, width: 12 + bw + G, height: (y1 - S) - cornerBottom)
        // occlusions in the top quarter join the corner obstacle on their side
        let topQuarter = CGRect(x: x0, y: y1 - safe.height / 4, width: safe.width, height: safe.height / 4)
        for o in chrome.occlusions where o.intersects(topQuarter) {
            if o.midX < cx { cornerL = cornerL.union(o) } else { cornerR = cornerR.union(o) }
        }
        let corners = [cornerL, cornerR]

        // hand
        let yHB = y0 + max(12, P + G)
        let handTop = yHB + cardSize.height * s
        let liftTop = handTop + lift * s
        // bid band
        let bidW = min(safeW - 16, bidBandSize.width)
        let bid = CGRect(x: cx - bidW / 2, y: liftTop + 4, width: bidW, height: bidBandSize.height)
        var yLo = liftTop + G
        let fold = chrome.fold.flatMap { f -> CGRect? in
            let scene = CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)
            return f.intersects(scene) ? f : nil
        }
        let tabletop = fold.map { $0.width > $0.height } ?? false
        let book = fold.map { $0.height > $0.width } ?? false
        if let f = fold, tabletop {
            yLo = max(yLo, f.maxY + G)
            if strict && bid.maxY > f.minY - G { return nil }
        }

        func parts(_ x: CGFloat, _ y: CGFloat, bubble: CGRect) -> [CGRect] { [glowRect(CGPoint(x: x, y: y)), nameRect(CGPoint(x: x, y: y)), bubble] }

        let ks: [Int] = strict ? Array(0..<7) : [6]
        for ki in ks {
            let k = 1.0 - 0.05 * CGFloat(ki)
            let tw = 80 * k, th = 116 * k
            let ox = tw + G, oy = th / 2 + G / 2
            let hc = th + G / 2
            let chw = 1.5 * tw + G
            var tcx = cx
            if let f = fold, book {
                let left = (x0, f.minX - G), right = (f.maxX + G, x1)
                let side = right.1 - right.0 >= left.1 - left.0 ? right : left
                tcx = (side.0 + side.1) / 2
            }
            // partner
            var yP = topLimit - glowRadius
            let pbub: (CGFloat) -> CGRect = { y in rect(CGPoint(x: tcx + topBubbleDX, y: y), bubbleSize) }
            for c in corners {
                let ps = parts(tcx, yP, bubble: pbub(yP))   // evaluated once per corner, as in the reference
                for p in ps where xover(p, c) {
                    yP = min(yP, c.minY - G - (p.maxY - yP))
                }
            }
            // side seat x: table radius, capped by the safe edge
            let radius = chw + G + nameMaxWidth / 2 + 60
            var lx = max(x0 + 52, tcx - radius)
            var rx = min(x1 - 52, tcx + radius)
            if let f = fold, book {
                // a side seat that would straddle the hinge moves to the far side of it
                if lx + nameMaxWidth / 2 > f.minX - G && lx - nameMaxWidth / 2 < f.maxX + G {
                    lx = f.minX - G - nameMaxWidth / 2
                }
                if rx + nameMaxWidth / 2 > f.minX - G && rx - nameMaxWidth / 2 < f.maxX + G {
                    rx = f.maxX + G + nameMaxWidth / 2
                }
            }
            let row = (tcx - lx) - nameMaxWidth / 2 >= chw + G && (rx - tcx) - nameMaxWidth / 2 >= chw + G
            let ccMin = yLo + hc
            let ccMax = yP - 45 - hc
            if strict && ccMax < ccMin { continue }
            func sideRects(_ y: CGFloat) -> [CGRect] {
                [lx, rx].flatMap { x in parts(x, y, bubble: rect(CGPoint(x: x, y: y + sideBubbleDY), bubbleSize)) }
            }
            var ySHi = topLimit - glowRadius
            var ySLo = yLo + 84 - G
            let probe = sideRects(0)
            for c in corners where probe.contains(where: { xover($0, c) }) {
                ySHi = min(ySHi, c.minY - G - glowRadius)
            }
            if probe.contains(where: { xover($0, bid) }) {
                ySLo = max(ySLo, bid.maxY + G + 84)
            }
            let pb = pbub(0)
            let partnerBubbleOverSides = probe.contains(where: { xover(pb, $0) })
            if partnerBubbleOverSides {
                ySHi = min(ySHi, yP - bubbleSize.height / 2 - G - (-nameLo) + 13)
                ySHi = min(ySHi, yP - 18 - G + 26)
            }
            var cc: CGFloat, yS: CGFloat
            if row {
                cc = (ccMin + ccMax) / 2
                yP = min(yP, cc + hc + 45 + 60)
                if partnerBubbleOverSides { ySHi = min(ySHi, yP - 18 - G + 26) }
                yS = min(max(cc, ySLo), ySHi)
                if strict && yS < ySLo - 0.01 { continue }
            } else {
                cc = min((ccMin + ccMax) / 2, ySHi - 84 - G - th / 2)
                if strict && cc < ccMin - 0.01 { continue }
                yS = max(ySLo, cc + th / 2 + G + 84)
                if strict && yS > ySHi + 0.01 { continue }
            }
            // history (Q2: left of my slot, below the left card) and accessory (Q3) must fit
            let bottomSlot = rect(CGPoint(x: tcx, y: cc - oy), CGSize(width: tw, height: th))
            let leftCardBottom = cc - th / 2, rightCardBottom = cc - th / 2
            let regRight = bottomSlot.minX - G
            let hw = min(historyIcon.width + 14 * 12, regRight - (x0 + M))
            if strict && (yLo + historyHeight > leftCardBottom - G + 0.01 || hw < historyIcon.width) { continue }
            let ax0 = bottomSlot.maxX + G
            var aw = min(140, x1 - M - ax0)
            if aw < accessoryRow.width - 0.01 { aw = min(aw, accessoryStack.width) }
            let ah = min(accessoryStack.height, rightCardBottom - G - yLo)
            let fits = (aw >= accessoryRow.width - 0.01 && ah >= accessoryRow.height - 0.01)
                || (aw >= accessoryStack.width - 0.01 && ah >= accessoryStack.height - 0.01)
            if strict && !fits { continue }

            var sol = Solution(
                s: s, k: k, mode: row ? .row : .raised, bottomBar: P,
                safe: safe, topLimit: topLimit, corners: corners,
                handBaseline: CGPoint(x: cx, y: yHB + cardSize.height * s / 2), handTop: handTop, liftTop: liftTop,
                tcx: tcx, cc: cc, ox: ox, oy: oy, yP: yP, yS: yS, lx: lx, rx: rx, yLo: yLo,
                bid: bid, accessory: CGRect(x: ax0, y: yLo, width: max(0, aw), height: max(0, ah)),
                historyOrigin: CGPoint(x: regRight - max(0, hw) + historyIcon.width / 2, y: yLo + historyHeight - historyIcon.height / 2),
                historySpacing: max(0, min(14, (hw - historyIcon.width) / 12)))
            if !strict { clampDegraded(&sol, tw: tw, th: th) }
            return sol
        }
        return nil
    }

    /// Degraded fallback: keep every anchor inside the safe rect (overlaps are possible).
    private static func clampDegraded(_ sol: inout Solution, tw: CGFloat, th: CGFloat) {
        let safe = sol.safe
        func c(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
            guard v.isFinite else { return (lo + hi) / 2 }
            return lo <= hi ? min(max(v, lo), hi) : (lo + hi) / 2
        }
        let top = min(safe.maxY, sol.topLimit)
        sol.tcx = c(sol.tcx, safe.minX + sol.ox + tw / 2, safe.maxX - sol.ox - tw / 2)
        sol.cc = c(sol.cc, safe.minY + sol.oy + th / 2, top - sol.oy - th / 2)
        sol.yP = c(sol.yP, safe.minY + glowRadius, top - glowRadius)
        sol.yS = c(sol.yS, safe.minY - nameLo, top - glowRadius)
        sol.lx = c(sol.lx, safe.minX + nameMaxWidth / 2, safe.maxX - nameMaxWidth / 2)
        sol.rx = c(sol.rx, safe.minX + nameMaxWidth / 2, safe.maxX - nameMaxWidth / 2)
        sol.yLo = c(sol.yLo, safe.minY, top)
        sol.bid = sol.bid.intersection(safe).isNull ? CGRect(x: safe.midX, y: safe.midY, width: 0, height: 0) : sol.bid
        let a = sol.accessory
        sol.accessory = CGRect(x: c(a.minX, safe.minX, safe.maxX - a.width), y: c(a.minY, safe.minY, top - a.height),
                               width: min(a.width, safe.width), height: min(a.height, max(0, top - safe.minY)))
        sol.historyOrigin = CGPoint(x: c(sol.historyOrigin.x, safe.minX + historyIcon.width / 2, safe.maxX - historyIcon.width / 2),
                                    y: c(sol.historyOrigin.y, safe.minY + 30 + historyIcon.height / 2, top - historyIcon.height / 2))
        sol.handBaseline.y = c(sol.handBaseline.y, safe.minY, safe.maxY)
    }
}
