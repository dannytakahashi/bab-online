import CoreGraphics

/// My seat's row (owner, 2026-11-12): everything about my own seat reads as one
/// group just above my hand, on the right: my trick pips, then HSI, then the
/// voice button. It starts 8 pt right of my trick slot, 8 pt above my lifted
/// hand (in a tabletop pose below the fold, with the hand), and keeps 8 pt (`seatRowGap`) from the trick cards, the trick piles,
/// every other seat (glow, name, bid bubble), the corner buttons, the fold and
/// the safe area's edges. The spectator badge keeps 8 pt from it
/// (TableLayout+Spectators.swift). The bid panel is exempt: the row is hidden
/// on my bid turn (HSI shows inside the panel then), and my pips show only once
/// the bidding is over.
///
/// It takes the first form that fits (y up: the hand is below):
/// - `.row`: pips | HSI | voice side by side (186 x 44), where the window is wide
///   (the iPad, the open Duo);
/// - `.compact`: my pips above HSI in a column, the voice button beside it
///   (122 x 44): every phone, the closed Duo, a book page;
/// - `.narrow`: HSI above my pips | voice (104 x 68), a window too narrow for that
///   (an iPad Slide Over window that is not tall);
/// - `.stacked`: voice, HSI, my pips in one column (74 x 92), narrower still.
/// Only a degraded layout (nothing fits) may place it over something.
///
/// Every slot is reserved at its largest (13 pips, "HSI 999.9" at its Dynamic Type
/// cap, the 44 pt button), so nothing moves when the pips appear or HSI changes.
/// My pips are a SpriteKit node (GameSKScene.myPipsNode at `myPipsCenter`), HSI and
/// voice SwiftUI (GameContainerView.seatRow at `hsi` / `voice`; in `.row` and
/// `.compact` the button follows HSI, at most at its slot).
extension TableLayout {
    struct SeatRow: Equatable {
        enum Mode: Equatable, CaseIterable { case row, compact, narrow, stacked }
        let mode: Mode
        /// Everything the row may draw (scene coordinates).
        let content: CGRect
        /// My pips' box.
        let pips: CGRect
        /// HSI's slot (the badge is leading-aligned in it, vertically centred).
        let hsi: CGRect
        /// The voice button.
        let voice: CGRect
        /// The content fit with 8 pt to spare (false only in a degraded layout).
        let fits: Bool

        /// HSI and the voice button side by side (one HStack in SwiftUI).
        var voiceFollowsHSI: Bool { mode == .row || mode == .compact }
    }

    /// The clear gap around my seat's row.
    static let seatRowGap: CGFloat = 8
    /// Between the items of the `.row` form (pips, HSI, voice).
    static let seatRowSpacing: CGFloat = 6
    /// Between the items of the other forms, which have less room.
    static let seatRowColumnSpacing: CGFloat = 4
    /// HSIBadge at its largest ("HSI 999.9" at its Dynamic Type cap, .large).
    static let hsiSize = CGSize(width: 74, height: 20)
    /// The voice button (Theme.hitTarget).
    static let voiceButtonSize: CGFloat = 44

    /// The row's size in each form.
    static func seatRowSize(_ mode: SeatRow.Mode) -> CGSize {
        let p = myPipsSize, h = hsiSize, v = voiceButtonSize, s = seatRowSpacing, c = seatRowColumnSpacing
        switch mode {
        case .row: return CGSize(width: p.width + s + h.width + s + v, height: max(p.height, h.height, v))
        case .compact: return CGSize(width: max(p.width, h.width) + c + v, height: max(p.height + c + h.height, v))
        case .narrow: return CGSize(width: max(p.width + c + v, h.width), height: max(p.height, v) + c + h.height)
        case .stacked: return CGSize(width: max(p.width, h.width, v), height: v + c + h.height + c + p.height)
        }
    }

    /// What the row keeps `seatRowGap` from (scene coordinates; the fold separately).
    func seatRowKeeps() -> [CGRect] {
        var keeps: [CGRect] = [Positions.RelativePosition.top, .left, .right, .bottom].map(trickRect)
        for r in [Positions.RelativePosition.top, .left, .right] {
            keeps.append(seatFootprint(r))
            keeps.append(bubbleRect(r))
        }
        // the piles as drawn: the border's pad and 2 pt of stroke
        let m = TrickHistoryNode.borderPad + 2
        keeps.append(historyRect.insetBy(dx: -m, dy: -m))
        keeps.append(contentsOf: cornerRects)
        return keeps
    }

    /// The fold the row keeps clear of (none when the layout ignored it).
    private var seatRowFold: CGRect? {
        guard let f = chrome.fold, !foldIgnored else { return nil }
        let scene = CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)
        return f.intersects(scene) ? f : nil
    }

    /// `r` keeps `seatRowGap` from every keep, the fold and the safe area's edges.
    func seatRowIsClear(_ r: CGRect) -> Bool {
        let G = Self.seatRowGap
        guard r.minX >= safeRect.minX + G - 0.01, r.maxX <= safeRect.maxX - G + 0.01, r.minY >= safeRect.minY + G - 0.01,
              r.maxY <= topLimit - G + 0.01, r.minY >= liftTop + G - 0.01 else { return false }
        if let f = seatRowFold, Self.overlaps(f.insetBy(dx: -G, dy: -G), r) { return false }
        return !seatRowKeeps().contains { Self.overlaps($0.insetBy(dx: -G, dy: -G), r) }
    }

    func computeSeatRow() -> SeatRow {
        let G = Self.seatRowGap
        let x0 = trickRect(.bottom).maxX + G
        // just above my lifted hand; in a tabletop pose that is below the fold, with the hand
        // (the bid panel's half), else above the fold beside the trick cluster
        var floors = [liftTop + G]
        if let f = seatRowFold, f.width > f.height { floors.append(max(liftTop, f.maxY) + G) }
        for floor in floors {
            for mode in SeatRow.Mode.allCases {
                let s = Self.seatRowSize(mode)
                let r = CGRect(x: x0, y: floor, width: s.width, height: s.height)
                if seatRowIsClear(r) { return Self.seatRow(mode, r, fits: true) }
            }
        }
        let s = Self.seatRowSize(.compact)
        return Self.seatRow(.compact, CGRect(x: x0, y: floors[floors.count - 1], width: s.width, height: s.height), fits: false)
    }

    /// The row's parts inside `content` (scene coordinates, y up: the hand is below).
    static func seatRow(_ mode: SeatRow.Mode, _ content: CGRect, fits: Bool) -> SeatRow {
        let p = myPipsSize, h = hsiSize, v = voiceButtonSize, s = seatRowSpacing, c = seatRowColumnSpacing
        let x = content.minX, y = content.minY
        func r(_ x: CGFloat, _ y: CGFloat, _ size: CGSize) -> CGRect { CGRect(origin: CGPoint(x: x, y: y), size: size) }
        let vs = CGSize(width: v, height: v)
        switch mode {
        case .row:
            let mid = content.midY
            return SeatRow(mode: mode, content: content, pips: r(x, mid - p.height / 2, p), hsi: r(x + p.width + s, mid - h.height / 2, h),
                           voice: r(x + p.width + s + h.width + s, mid - v / 2, vs), fits: fits)
        case .compact:
            // HSI along the bottom of the left column, my pips above it, the voice button beside the column
            let col = max(p.width, h.width)
            return SeatRow(mode: mode, content: content, pips: r(x, y + h.height + c, p), hsi: r(x, y, h),
                           voice: r(x + col + c, y + (content.height - v) / 2, vs), fits: fits)
        case .narrow:
            // my pips and the voice button along the bottom, HSI above them
            let tier = max(p.height, v)
            return SeatRow(mode: mode, content: content, pips: r(x, y + (tier - p.height) / 2, p), hsi: r(x, y + tier + c, h),
                           voice: r(x + p.width + c, y + (tier - v) / 2, vs), fits: fits)
        case .stacked:
            return SeatRow(mode: mode, content: content, pips: r(x, y + v + c + h.height + c, p), hsi: r(x, y + v + c, h),
                           voice: r(x, y, vs), fits: fits)
        }
    }
}
