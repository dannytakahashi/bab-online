import CoreGraphics

/// The lightbulb on my play turn (pure, pane points; owner 2026-11-19 on build 19: "Light bulb is
/// beautiful! But notice it sometimes overlaps hsi"). Its home is today's spot: the drawn 36 pt
/// button's right edge at my hand's right end, 2 pt above the lifted cards (`askHome`). With a
/// short hand that end lands in my seat's row, which sits at the same height (HSI, my pips, the
/// voice button: TableLayout+SeatRow.swift), so the home is kept only while it is clear
/// (`askProblems` empty), and otherwise the button moves to a clear spot (`askFrame`), where:
/// - the drawn button keeps `askGap` from what my seat's row draws (my pips' pill, HSI's badge
///   at its widest) and from the rest of the table (the other seats' trick cards (mine is empty
///   on my turn), the other seats with their bid bubbles,
///   my bid bubble, the piles, the card fans, the corner buttons, the fold), and never covers
///   my hand;
/// - its 44 pt tap square stays off the other tap targets there (the voice button, the
///   spectator badge) and inside the safe area under the score bar;
/// - it stays with my hand: never lower than its home, at most `askReach` above it, never right
///   of it, its centre over the hand's span.
/// Where my seat's row is in the way it keeps one lane for the whole hand (`askLane`, the same
/// for every hand size the row blocks, so it does not hop from side to side of the row from one
/// turn to the next as the hand shrinks; reviewer 2026-11-19): first the same height just left
/// of the row (fixed while the hand's right end walks across the row, then today's spot again
/// once that end is past it), else straight above the row at the hand's right end. Only when
/// neither lane is clear for every such hand size, or something other than the row is in the
/// way, does it take the clear spot nearest the home among the x and y at which it just clears
/// an edge of what it keeps off (the same height first on a tie). Only a degraded table with no clear spot near the
/// hand looks anywhere on the felt, and then keeps the home. The bid turn's lightbulb is the bid
/// panel's (BidOverlayView), unchanged.
extension AssistLayout {
    /// The lightbulb's tap square (the 36 pt button is centred in it).
    static var askHit: CGFloat { max(askSize, Theme.hitTarget) }
    /// The drawn button's clear gap from my seat's row and the rest of the table.
    static let askGap: CGFloat = 4
    /// How far above its home the lightbulb may go and still read as my hand's (a tap square and
    /// a half: over my seat's row on a phone).
    static let askReach: CGFloat = 112
    private static var askInset: CGFloat { (askHit - askSize) / 2 }

    /// What the lightbulb keeps clear of on my play turn (pane points).
    struct AskKeeps: Equatable {
        /// My hand's box (its cards' width, its baseline to the lifted cards' top).
        var hand: CGRect
        /// What my seat's row draws and the button keeps `askGap` from: "pips" (the pill my
        /// pips draw), "hsi" (HSI's slot).
        var drawn: [String: CGRect] = [:]
        /// Tap targets the tap square stays off: "voice", "spectators".
        var taps: [String: CGRect] = [:]
        /// The rest of the table the button keeps `askGap` from.
        var table: [CGRect] = []
        /// Where the tap square stays: the safe area under the score bar.
        var bounds: CGRect
        /// My hand's box at every size the hand can have on this table (1...13 cards; empty:
        /// `hand` alone): the lane the lightbulb takes around my seat's row is chosen for all of
        /// them at once (`askLane`).
        var hands: [CGRect] = []

        /// The same table with my hand at `hand`.
        func with(hand: CGRect) -> AskKeeps {
            var k = self
            k.hand = hand
            return k
        }
    }

    /// How the lightbulb gets round my seat's row while that is on its home (one per table and
    /// row state): `.left` at the same height just left of the row (that tap square's x), `.lift`
    /// straight above the row at the hand's right end (that tap square's y).
    enum AskLane: Equatable {
        case left(CGFloat)
        case lift(CGFloat)
    }

    /// Today's spot: the drawn button's right edge at the hand's right end, its bottom 2 pt above
    /// the lifted cards (the tap square, 4 pt larger each way).
    static func askHome(hand: CGRect) -> CGRect {
        CGRect(x: max(0, hand.maxX - askHit + askInset), y: max(0, hand.minY - askHit + askInset - 2), width: askHit, height: askHit)
    }

    /// The drawn button in a tap square.
    static func askButton(_ hit: CGRect) -> CGRect { hit.insetBy(dx: askInset, dy: askInset) }

    /// What the lightbulb at `hit` (its tap square) covers: the names of `drawn` / `taps` it is
    /// on, "table", "hand", "offscreen" (empty: clear).
    static func askProblems(_ hit: CGRect, _ k: AskKeeps) -> [String] {
        let button = askButton(hit), padded = askButton(hit).insetBy(dx: -askGap, dy: -askGap)
        func over(_ a: CGRect, _ b: CGRect) -> Bool { TableLayout.overlaps(a, b) }
        var out: [String] = []
        let b = k.bounds.insetBy(dx: -0.01, dy: -0.01)
        if !b.contains(hit) { out.append("offscreen") }
        for (name, r) in k.drawn.sorted(by: { $0.key < $1.key }) where over(padded, r) { out.append(name) }
        for (name, r) in k.taps.sorted(by: { $0.key < $1.key }) where over(hit, r) { out.append(name) }
        if k.table.contains(where: { over(padded, $0) }) { out.append("table") }
        if over(button, k.hand) { out.append("hand") }
        return out
    }

    /// My seat's row and what sits by it, as the lightbulb goes round them: what the row draws
    /// (kept `askGap` from), the voice button and the spectator badge (kept off by the tap square).
    private static func rowParts(_ k: AskKeeps) -> [String: (r: CGRect, tap: Bool)] {
        var out: [String: (r: CGRect, tap: Bool)] = k.drawn.mapValues { ($0, false) }
        for name in ["voice", "spectators"] { if let r = k.taps[name] { out[name] = (r, true) } }
        return out
    }

    /// Whether `problems` (from `askProblems`) include my seat's row (or the badge by it).
    static func onRow(_ problems: [String], _ k: AskKeeps) -> Bool { !Set(rowParts(k).keys).isDisjoint(with: problems) }

    /// The lane round my seat's row (nil: neither is clear for every hand size the row blocks, or
    /// the row blocks none), from the parts of the row that are on the home of any hand size:
    /// `.left` the tap square's x just left of all of them, at the home's height, its centre over
    /// each such hand and left of its home; `.lift` its y just above all of them (within
    /// `askReach`), at each such hand's right end.
    static func askLane(_ k: AskKeeps) -> AskLane? {
        let hit = askHit, inset = askInset, g = askGap
        let parts = rowParts(k)
        var hands: [CGRect] = [], names: Set<String> = []
        for h in k.hands.isEmpty ? [k.hand] : k.hands {
            let on = Set(askProblems(askHome(hand: h), k.with(hand: h))).intersection(parts.keys)
            if !on.isEmpty { hands.append(h); names.formUnion(on) }
        }
        let row = names.compactMap { parts[$0] }
        guard !hands.isEmpty, !row.isEmpty else { return nil }
        let left = row.map { $0.tap ? $0.r.minX - hit : $0.r.minX - g - askSize - inset }.min()!
        let above = row.map { $0.tap ? $0.r.minY - hit : $0.r.minY - g - askSize - inset }.min()!
        let leftOK = hands.allSatisfy { h in
            let home = askHome(hand: h), r = CGRect(x: left, y: home.minY, width: hit, height: hit)
            return r.minX < home.minX && r.midX >= h.minX - 0.01 && r.midX <= h.maxX + 0.01 && askProblems(r, k.with(hand: h)).isEmpty
        }
        if leftOK { return .left(left) }
        let liftOK = hands.allSatisfy { h in
            let home = askHome(hand: h), r = CGRect(x: home.minX, y: above, width: hit, height: hit)
            return r.minY < home.minY && r.minY >= home.minY - askReach - 0.01 && askProblems(r, k.with(hand: h)).isEmpty
        }
        return liftOK ? .lift(above) : nil
    }

    /// The lightbulb's tap square: its home while that is clear, else its lane round my seat's
    /// row, else the clear spot nearest the home.
    static func askFrame(_ k: AskKeeps) -> CGRect {
        let home = askHome(hand: k.hand)
        let problems = askProblems(home, k)
        if problems.isEmpty { return home }
        let hit = askHit, inset = askInset, g = askGap
        if onRow(problems, k), let lane = askLane(k) {
            let r: CGRect
            switch lane {
            case .left(let x): r = CGRect(x: x, y: home.minY, width: hit, height: hit)
            case .lift(let y): r = CGRect(x: home.minX, y: y, width: hit, height: hit)
            }
            if askProblems(r, k).isEmpty { return r }
        }
        // every x / y at which the tap square (or the button with its gap) just clears an edge
        var xs: [CGFloat] = [home.minX, k.bounds.minX, k.bounds.maxX - hit]
        var ys: [CGFloat] = [home.minY, k.bounds.minY]
        for r in Array(k.drawn.values) + k.table + [k.hand] {
            xs += [r.minX - g - askSize - inset, r.maxX + g - inset]
            ys += [r.minY - g - askSize - inset, r.maxY + g - inset]
        }
        for r in k.taps.values {
            xs += [r.minX - hit, r.maxX]
            ys += [r.minY - hit, r.maxY]
        }
        func nearest(_ near: Bool) -> CGRect? {
            var best: (d: CGFloat, dy: CGFloat, r: CGRect)?
            for y in ys {
                if near, y > home.minY + 0.01 || y < home.minY - askReach - 0.01 { continue }
                for x in xs {
                    let r = CGRect(x: x, y: y, width: hit, height: hit)
                    // its centre over the hand, never right of the home (so never past the hand's end)
                    if near, r.midX < k.hand.minX - 0.01 || r.minX > home.minX + 0.01 { continue }
                    let d = hypot(x - home.minX, y - home.minY), dy = abs(y - home.minY)
                    if let b = best, d > b.d + 0.01 || (abs(d - b.d) <= 0.01 && dy >= b.dy) { continue }
                    if askProblems(r, k).isEmpty { best = (d, dy, r) }
                }
            }
            return best?.r
        }
        return nearest(true) ?? nearest(false) ?? home
    }
}

extension AssistLayout {
    /// My hand's box in the pane's points (its `count` cards' width at the hand's scale, from its
    /// baseline to the lifted cards' top): the card and the lightbulb are placed from it, so on
    /// the Duo they follow the hand below the fold.
    static func handBox(_ L: TableLayout, count: Int) -> CGRect {
        let n = max(count, 1)
        let width = TableLayout.cardSize.width * L.handScale + L.handOverlap(count: n) * CGFloat(n - 1)
        let bottom = L.handTop - TableLayout.cardSize.height * L.handScale
        return L.window(CGRect(x: L.handBaseline.x - width / 2, y: bottom, width: width, height: L.liftTop - bottom))
    }

    /// What the lightbulb keeps clear of on my play turn, from the table's layout (pane points):
    /// my seat's row as it draws now (my pips' pill for `pipSlots` > 0, HSI's slot with `hsi`,
    /// the voice button with `voice`), the spectator badge (`spectatorBadge`, the pane's rect)
    /// while it shows, the other seats' trick cards, glow, names and bid bubbles, my bid bubble,
    /// the piles, the corner buttons, the card fans and the fold.
    static func askKeeps(_ L: TableLayout, handCount: Int, pipSlots: Int, hsi: Bool, voice: Bool,
                         spectatorBadge: CGRect? = nil) -> AskKeeps {
        let row = L.seatRow
        var drawn: [String: CGRect] = [:]
        if pipSlots > 0 { drawn["pips"] = L.window(TableLayout.rect(L.myPipsCenter(slots: pipSlots), TableLayout.myPipsPill(pipSlots))) }
        // the badge is leading in its slot and never wider than hsiSize (its type is not zoomed)
        if hsi { drawn["hsi"] = L.window(row.hsi).divided(atDistance: TableLayout.hsiSize.width, from: .minXEdge).slice }
        var taps: [String: CGRect] = [:]
        if voice { taps["voice"] = L.window(row.voice) }
        if let spectatorBadge { taps["spectators"] = spectatorBadge }
        // the other seats' trick cards (my slot is empty on my turn), glow and name, the bid
        // bubbles (mine on the first trick's lead), the piles as drawn, the corner buttons
        let others: [Positions.RelativePosition] = [.top, .left, .right]
        var table = others.map(L.trickRect) + others.map(L.seatFootprint) + (others + [.bottom]).map(L.bubbleRect)
        let m = TrickHistoryNode.borderPad + 2
        table.append(L.historyRect.insetBy(dx: -m, dy: -m))
        table += L.cornerRects
        if let fans = L.fans(spectating: false) { table += fans.values }
        if let f = L.chrome.fold, !L.foldIgnored { table.append(f) }
        let s = L.safeRect
        let bounds = L.window(CGRect(x: s.minX, y: s.minY, width: s.width, height: max(0, min(s.maxY, L.topLimit) - s.minY)))
        return AskKeeps(hand: handBox(L, count: handCount), drawn: drawn, taps: taps, table: table.map(L.window), bounds: bounds,
                        hands: (1...13).map { handBox(L, count: $0) })
    }
}
