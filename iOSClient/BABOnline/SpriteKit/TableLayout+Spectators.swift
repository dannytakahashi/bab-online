import CoreGraphics
import Foundation

/// The last few watcher clusters solved (TableLayout.watcherCluster), by layout and phase.
private final class WatcherClusterCache: @unchecked Sendable {
    static let shared = WatcherClusterCache()
    private let lock = NSLock()
    private var entries: [(layout: TableLayout, bidding: Bool, cluster: TableLayout.WatcherCluster)] = []

    func get(_ layout: TableLayout, _ bidding: Bool) -> TableLayout.WatcherCluster? {
        lock.lock(); defer { lock.unlock() }
        return entries.first { $0.bidding == bidding && $0.layout == layout }?.cluster
    }

    func put(_ layout: TableLayout, _ bidding: Bool, _ cluster: TableLayout.WatcherCluster) {
        lock.lock(); defer { lock.unlock() }
        entries.insert((layout, bidding, cluster), at: 0)
        if entries.count > 8 { entries.removeLast() }
    }
}

/// The spectator badge (eye + count, a 44 pt target) and its chat bubble
/// (V1_REMOVALS "iOS spectator badge" 5 and 7), placed from the solved
/// layout without changing it: the badge takes the first candidate spot that
/// keeps clear of the hand, my seat's row (pips, HSI, voice; by 8 pt), the trick cards, the
/// trick history, every seat (glow, name, bid bubble) and the corner buttons;
/// the bid band is exempt (the panel shows only on my bid turn and may cover
/// the badge then, as it does the accessory).
///
/// - Seated (a hand on screen): beside my seat's row (right of it, else above
///   it at the right edge), else the left edge above the history, else under
///   the Log button.
/// - Spectating (no hand): the bottom-right corner, above the pill.
/// Then the clear spot nearest the first candidate; on a packed table the
/// bid bubbles and history may be covered (never the always-on parts); where
/// even that fails (a degraded layout) the first candidate clamped into the
/// safe rect.
extension TableLayout {
    /// Wide enough for the badge's widest form ("99+" at its Dynamic Type cap, .large;
    /// SpectatorBadgeFitTests measures it) and no wider: 66 pt no longer keeps clear on an SE.
    static let spectatorBadgeSize = CGSize(width: 60, height: 44)

    /// The badge's rect in scene coordinates.
    func spectatorBadge(spectating: Bool) -> CGRect {
        let cands = spectatorBadgeCandidates(spectating: spectating)
        let all = spectatorKeeps(spectating: spectating)
        for c in cands where isClear(c, keeps: all) { return c }
        let first = cands.first ?? .zero
        if let r = nearestClear(to: first, keeps: all) { return r }
        // a packed table (an SE-size window at zero insets): clear of everything that is always on
        // screen, over a bid bubble or the trick history at worst
        let hard = spectatorKeeps(spectating: spectating, soft: false)
        for c in cands where isClear(c, keeps: hard) { return c }
        return nearestClear(to: first, keeps: hard) ?? clampIntoSafe(first)
    }

    /// The clear spot nearest `first`, along the right and left edges and `first`'s row
    /// (2 pt steps: a few hundred rects).
    private func nearestClear(to first: CGRect, keeps: [CGRect]) -> CGRect? {
        let w = Self.spectatorBadgeSize.width, h = Self.spectatorBadgeSize.height
        var best: CGRect?
        var bestD = CGFloat.infinity
        func consider(_ x: CGFloat, _ y: CGFloat) {
            let r = CGRect(x: x, y: y, width: w, height: h)
            let d = hypot(x - first.minX, y - first.minY)
            if d < bestD, isClear(r, keeps: keeps) { best = r; bestD = d }
        }
        let top = min(safeRect.maxY, topLimit) - h
        var y = safeRect.minY
        while y <= top {
            consider(safeRect.maxX - Self.margin - w, y)
            consider(safeRect.minX + Self.margin, y)
            y += 2
        }
        var x = safeRect.minX + Self.margin
        while x <= safeRect.maxX - Self.margin - w {
            consider(x, first.minY)
            x += 2
        }
        return best
    }

    /// What the badge (and its bubble) must not cover. `soft: false` leaves out what is on
    /// screen only part of the time (the bid bubbles: bidding and the first trick; the history).
    func spectatorKeeps(spectating: Bool, soft: Bool = true) -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        let seats: [Positions.RelativePosition] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats {
            keeps.append(seatFootprint(r))
            if soft { keeps.append(bubbleRect(r)) }
        }
        if soft { keeps.append(historyRect) }
        keeps.append(contentsOf: cornerRects)
        if !spectating {
            keeps.append(CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, liftTop - safeRect.minY)))
            // my seat's row (pips, HSI, voice) with its 8 pt clearance
            keeps.append(accessoryContent.insetBy(dx: -Self.seatRowGap, dy: -Self.seatRowGap))
            if soft { keeps.append(bubbleRect(.bottom)) }
        }
        return keeps
    }

    /// What my seat's row (my pips, HSI, voice) may cover: `seatRow.content`.
    var accessoryContent: CGRect { seatRow.content }

    /// The trick history's two rows (Q2: left of my trick slot).
    var historyRect: CGRect {
        let w = Self.historyIcon.width + 12 * historySpacing
        return CGRect(x: historyOrigin.x - Self.historyIcon.width / 2, y: historyOrigin.y + Self.historyIcon.height / 2 - Self.historyHeight,
                      width: w, height: Self.historyHeight)
    }

    private func spectatorBadgeCandidates(spectating: Bool) -> [CGRect] {
        let w = Self.spectatorBadgeSize.width, h = Self.spectatorBadgeSize.height
        let G = Self.gap, M = Self.margin
        let right = safeRect.maxX - M - w, left = safeRect.minX + M
        let underLog = (cornerRects.last?.minY ?? topLimit) - G - h
        if spectating {
            let floor = safeRect.minY + max(12, chrome.bottomBar + G)
            return [CGRect(x: right, y: floor, width: w, height: h),
                    CGRect(x: right, y: floor + h + G, width: w, height: h),
                    CGRect(x: right, y: underLog, width: w, height: h)]
        }
        let row = accessoryContent, RG = Self.seatRowGap
        return [CGRect(x: row.maxX + RG, y: row.minY, width: w, height: h),
                CGRect(x: right, y: row.maxY + RG, width: w, height: h),
                CGRect(x: right, y: accessory.maxY + G, width: w, height: h),
                CGRect(x: left, y: historyRect.maxY + G, width: w, height: h),
                CGRect(x: right, y: underLog, width: w, height: h)]
    }

    private func isClear(_ r: CGRect, keeps: [CGRect]) -> Bool {
        guard r.minX >= safeRect.minX - 0.01, r.maxX <= safeRect.maxX + 0.01, r.minY >= safeRect.minY - 0.01,
              r.maxY <= topLimit + 0.01 else { return false }
        if let f = chrome.fold, f.intersects(r) { return false }
        return !keeps.contains { k in Self.overlaps(k, r) }
    }

    static func overlaps(_ a: CGRect, _ b: CGRect) -> Bool {
        min(a.maxX, b.maxX) - max(a.minX, b.minX) > 0.01 && min(a.maxY, b.maxY) - max(a.minY, b.minY) > 0.01
    }

    private func clampIntoSafe(_ r: CGRect) -> CGRect {
        func c(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { lo <= hi ? min(max(v, lo), hi) : lo }
        let top = min(safeRect.maxY, topLimit)
        return CGRect(x: c(r.minX, safeRect.minX, safeRect.maxX - r.width), y: c(r.minY, safeRect.minY, top - r.height),
                      width: r.width, height: r.height)
    }

    /// The bottom pill's strip (Spectating / Exit, the lazy pill): the bottom of the safe
    /// rect up to the measured bar; empty without one.
    var bottomBarRect: CGRect {
        CGRect(x: safeRect.minX, y: safeRect.minY, width: safeRect.width, height: max(0, chrome.bottomBar))
    }

    /// The spectator chat bubble's center (`size` measured): above the badge, right-aligned
    /// with it; else left of it; else below it; else up the badge's edge; else the clear
    /// spot nearest the first; clear of the same keeps where it can be, and always of the
    /// badge and the bottom pill, inside the safe rect below the top bar.
    func spectatorBubbleCenter(badge: CGRect, bubbleSize size: CGSize, spectating: Bool, voice watcherVoice: CGRect? = nil) -> CGPoint {
        let G = Self.gap, M = Self.margin
        // a watcher's own voice button by the badge (watcherVoiceSpot) is never covered
        let voice: [CGRect] = spectating ? [] : watcherVoice.map { [$0] } ?? []
        // the bid panel covers the transient layer on my bid turn: keep the bubble off its band
        let keeps = spectatorKeeps(spectating: spectating) + (spectating ? [] : [bidBand]) + [badge, bottomBarRect] + voice
        let hard = spectatorBubbleHardKeeps(spectating: spectating) + [badge, bottomBarRect] + voice
        let minX = safeRect.minX + M, maxX = safeRect.maxX - M
        func fit(_ x: CGFloat) -> CGFloat { min(max(x, minX), max(minX, maxX - size.width)) }
        func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: fit(x), y: y, width: size.width, height: size.height) }
        var spots = [
            at(badge.maxX - size.width, badge.maxY + G),
            at(badge.minX - G - size.width, badge.midY - size.height / 2),
            at(badge.maxX - size.width, badge.minY - G - size.height),
        ]
        // then higher up the badge's edge (past a trick card or a bid bubble), 4 pt steps
        var y = badge.maxY + G + 4
        while y + size.height <= topLimit {
            spots.append(at(badge.maxX - size.width, y))
            y += 4
        }
        // a phone has little room by the badge: like a seat's chat bubble, a 5 s spectator line may
        // then cover a trick slot, a bid bubble or the history, never a seat, the hand, HSI / voice,
        // the corner buttons or (seated) the bid band
        let chosen = spots.first { isClear($0, keeps: keeps) }
            ?? spots.first { isClear($0, keeps: hard) }
            ?? nearestClearBubble(to: spots[0], size: size, keeps: hard)
            ?? clampAboveBottomBar(spots[0])
        return CGPoint(x: chosen.midX, y: chosen.midY)
    }

    /// The clear spot for a `size` bubble nearest `first`, on a 4 pt grid of the safe rect.
    private func nearestClearBubble(to first: CGRect, size: CGSize, keeps: [CGRect]) -> CGRect? {
        let M = Self.margin
        var best: CGRect?
        var bestD = CGFloat.infinity
        var y = safeRect.minY + chrome.bottomBar
        while y + size.height <= min(safeRect.maxY, topLimit) {
            var x = safeRect.minX + M
            while x + size.width <= safeRect.maxX - M {
                let r = CGRect(x: x, y: y, width: size.width, height: size.height)
                let d = hypot(x - first.minX, y - first.minY)
                if d < bestD, isClear(r, keeps: keeps) { best = r; bestD = d }
                x += 4
            }
            y += 4
        }
        return best
    }

    /// `r` clamped into the safe rect, above the bottom pill and below the top bar.
    private func clampAboveBottomBar(_ r: CGRect) -> CGRect {
        func c(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { lo <= hi ? min(max(v, lo), hi) : lo }
        let top = min(safeRect.maxY, topLimit)
        return CGRect(x: c(r.minX, safeRect.minX + Self.margin, safeRect.maxX - Self.margin - r.width),
                      y: c(r.minY, safeRect.minY + chrome.bottomBar, top - r.height), width: r.width, height: r.height)
    }

    /// The over-the-shoulder view's eye and the watcher's OWN voice button as one cluster (owner
    /// 2026-11-21: "when spectating your unmute controls should be above the eye", then "mic
    /// and eye as one cluster"): the mic directly above the eye badge, centred on it, `gap`
    /// between them, on every device and pose. The cluster sits where the badge of the seated
    /// layout sits when the mic's place above it is clear; else the two move TOGETHER to the
    /// clear spot nearest it (up and down the right and left edges, along the badge's row, then
    /// anywhere), never splitting. Clear of the hand, my seat's row (the watched seat's), the
    /// seats (with their bid bubbles and dealer buttons), the card backs, the trick cards, the
    /// piles, the corner buttons, the fold, and the bid band with the clock pill above it (the
    /// watched seat's read-only bid sheet), so neither ever hides under the sheet; the /help
    /// column keeps off the cluster (`AssistLayout.Keeps.cluster`). A watcher always has the
    /// mic's place, shown or not, so the eye never moves when voice starts. Scene coordinates.
    struct WatcherCluster: Equatable {
        var badge: CGRect
        var voice: CGRect
        var union: CGRect { badge.union(voice) }
    }

    /// The badge of `watcherCluster` for a watcher, else the usual spot.
    func spectatorBadge(spectating: Bool, watching: Bool, bidding: Bool) -> CGRect {
        watching && !spectating ? watcherCluster(bidding: bidding).badge : spectatorBadge(spectating: spectating)
    }

    /// The watcher's voice button (`watcherCluster(bidding:).voice`).
    func watcherVoiceSpot(bidding: Bool) -> CGRect { watcherCluster(bidding: bidding).voice }

    /// The bid clock's pill above the bid band's trailing top corner (BidOverlayView: its
    /// bottom on the panel's top edge, Theme.Space.s3 in from the trailing edge), at its largest
    /// (the pill's type stops at xLarge), scene units.
    static let bidClockPillBox = CGSize(width: 80, height: 32)

    /// The read-only bid sheet: its band (and a gap above it) and the clock's pill.
    private var bidSheetKeeps: [CGRect] {
        let p = Self.bidClockPillBox
        return [CGRect(x: bidBand.minX, y: bidBand.minY, width: bidBand.width, height: bidBand.height + 2),
                CGRect(x: bidBand.maxX - 12 - p.width, y: bidBand.maxY, width: p.width + 12, height: p.height)]
    }

    /// The cluster: one spot for the whole hand where one keeps clear of the trick cards and
    /// the read-only bid sheet both; else (a small pane: an SE, the Duo closed) a spot for the
    /// bidding (`bidding`: the sheet may show, no trick cards on the table) and one for the play
    /// (trick cards, no sheet).
    func watcherCluster(bidding: Bool) -> WatcherCluster {
        // a few searches per layout, asked for by several views each render: kept per layout
        if let hit = WatcherClusterCache.shared.get(self, bidding) { return hit }
        let c = solveWatcherCluster(bidding: bidding)
        WatcherClusterCache.shared.put(self, bidding, c)
        return c
    }

    private func solveWatcherCluster(bidding: Bool) -> WatcherCluster {
        let s = Self.voiceButtonSize, G = Self.gap
        let w = Self.spectatorBadgeSize.width, h = Self.spectatorBadgeSize.height
        func cluster(_ x: CGFloat, _ y: CGFloat) -> WatcherCluster {
            let badge = CGRect(x: x, y: y, width: w, height: h)
            return WatcherCluster(badge: badge, voice: CGRect(x: badge.midX - s / 2, y: badge.maxY + G, width: s, height: s))
        }
        func clear(_ c: WatcherCluster, _ keeps: [CGRect]) -> Bool { isClear(c.badge, keeps: keeps) && isClear(c.voice, keeps: keeps) }
        let tricks = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        func phase(_ k: [CGRect]) -> [CGRect] { bidding ? k.filter { !tricks.contains($0) } + bidSheetKeeps : k }
        let extra = [Positions.RelativePosition.top, .left, .right].map(dealerChip) + Array((fans(spectating: false) ?? [:]).values)
        let base = spectatorBadge(spectating: false)
        let home = cluster(base.minX, base.minY)
        // the whole hand's spot (the eye and mic stay put from the deal to the last trick)
        let both = spectatorKeeps(spectating: false) + bidSheetKeeps + extra
        if clear(home, both) { return home }
        if let c = nearestClearCluster(to: base, keeps: both, make: cluster, clear: clear) { return c }
        let keeps = phase(spectatorKeeps(spectating: false)) + extra
        if clear(home, keeps) { return home }
        if let c = nearestClearCluster(to: base, keeps: keeps, make: cluster, clear: clear) { return c }
        // a packed table (an SE-size pane while the score bar shows a bore): over a seat's card
        // backs at worst, still clear of its avatar, name, bid bubble and dealer button
        let dealers = [Positions.RelativePosition.top, .left, .right].map(dealerChip)
        let noFans = phase(spectatorKeeps(spectating: false)) + dealers
        if let c = nearestClearCluster(to: base, keeps: noFans, make: cluster, clear: clear) { return c }
        // then clear of what is always on screen (never the hand, a seat or the sheet)
        let hard = phase(spectatorKeeps(spectating: false, soft: false)) + extra
        if let c = nearestClearCluster(to: base, keeps: hard, make: cluster, clear: clear) { return c }
        let top = min(safeRect.maxY, topLimit)
        let y = min(max(base.minY, safeRect.minY), max(safeRect.minY, top - h - G - s))
        let x = min(max(base.minX, safeRect.minX), max(safeRect.minX, safeRect.maxX - w))
        return cluster(x, y)
    }

    /// What the watcher's cluster covers, by name ([] = clear; the probe "table.shoulder"
    /// cluster= and the tests): the hand, the watched seat's row, the seats' avatars, names, bid
    /// bubbles and dealer buttons, the card backs, the piles, the corner buttons, the fold, the
    /// safe area, and the trick cards (play) or the read-only bid sheet with its clock (bidding).
    func watcherClusterProblems(bidding: Bool) -> [String] {
        let c = watcherCluster(bidding: bidding)
        var keeps = watchKeeps(spectating: false).filter { k in
            k.0 != "spectators" && k.0 != "banner" && k.0 != "bidPanel" && !(bidding && k.0.hasPrefix("trick."))
        }
        if bidding { keeps += bidSheetKeeps.map { ("bidPanel", $0) } }
        var out: [String] = []
        for part in [c.badge, c.voice] {
            if part.minX < safeRect.minX - 0.01 || part.maxX > safeRect.maxX + 0.01 || part.minY < safeRect.minY + chrome.bottomBar - 0.01
                || part.maxY > topLimit + 0.01 { out.append("safeArea") }
            for (name, k) in keeps where Self.overlaps(k, part) { out.append(name) }
        }
        if TableLayout.overlaps(c.badge, c.voice) { out.append("eachOther") }
        var seen = Set<String>()
        return out.filter { seen.insert($0).inserted }
    }


    /// The clear cluster nearest `base`: up and down the right and left edges and along the
    /// badge's row (2 pt steps), else anywhere on a 4 pt grid.
    private func nearestClearCluster(to base: CGRect, keeps: [CGRect], make: (CGFloat, CGFloat) -> WatcherCluster,
                                     clear: (WatcherCluster, [CGRect]) -> Bool) -> WatcherCluster? {
        let w = Self.spectatorBadgeSize.width, M = Self.margin
        let tall = Self.spectatorBadgeSize.height + Self.gap + Self.voiceButtonSize
        let top = min(safeRect.maxY, topLimit) - tall
        var best: WatcherCluster?
        var bestD = CGFloat.infinity
        func consider(_ x: CGFloat, _ y: CGFloat) {
            let d = hypot(x - base.minX, y - base.minY)
            guard d < bestD else { return }
            let c = make(x, y)
            if clear(c, keeps) { best = c; bestD = d }
        }
        var y = safeRect.minY
        while y <= top {
            consider(safeRect.maxX - M - w, y)
            consider(safeRect.minX + M, y)
            y += 2
        }
        var x = safeRect.minX + M
        while x <= safeRect.maxX - M - w {
            consider(x, base.minY)
            x += 2
        }
        if best != nil { return best }
        y = safeRect.minY
        while y <= top {
            x = safeRect.minX + M
            while x <= safeRect.maxX - M - w {
                consider(x, y)
                x += 4
            }
            y += 4
        }
        return best
    }

    /// What a spectator chat bubble never covers.
    func spectatorBubbleHardKeeps(spectating: Bool) -> [CGRect] {
        var keeps = spectatorKeeps(spectating: spectating, soft: false).filter { k in
            ![Positions.RelativePosition.top, .left, .right, .bottom].contains { trickRect($0) == k }
        }
        if !spectating { keeps.append(bidBand) }
        return keeps
    }
}
