import CoreGraphics
@testable import BAB_Online

/// A fingerprint of every TableLayout output a table reads, over every pane that must
/// never zoom (short side under TableLayout.zoomMinSide: every phone, the Duo closed and
/// open, Slide Over, an iPad split's narrow side) with the chromes they get. It uses only
/// API that existed before the zoom (main 6aab8f5), so the same code computed the pinned
/// value there: equal digests = those panes lay out exactly as before, value for value.
enum LayoutDigest {
    typealias Rel = Positions.RelativePosition

    /// The panes: a sweep (every short side < 700) plus the named phones and Duo poses.
    static var sizes: [CGSize] {
        var out: [CGSize] = []
        for w in stride(from: CGFloat(320), through: 1400, by: 37) {
            for h in stride(from: CGFloat(320), through: 1400, by: 41) where min(w, h) < 700 {
                out.append(CGSize(width: w, height: h))
            }
        }
        let named: [(CGFloat, CGFloat)] = [(320, 568), (375, 667), (390, 844), (393, 852), (402, 874), (414, 896), (428, 926),
                                           (430, 932), (440, 956), (466, 678), (669, 951), (546, 669), (455.5, 669), (572, 669),
                                           (320, 1032), (466, 1032), (678, 1032), (512, 1376), (320, 1180), (375, 1180)]
        for (w, h) in named {
            out.append(CGSize(width: w, height: h))
            out.append(CGSize(width: h, height: w))
        }
        return out.filter { min($0.width, $0.height) < 700 }
    }

    static var chromes: [TableChrome] {
        let notch = TableInsets(top: 59, left: 0, bottom: 34, right: 0)
        let side = TableInsets(top: 0, left: 59, bottom: 21, right: 59)
        let duo = TableInsets(top: 0, left: 0, bottom: 34, right: 84)
        var out: [TableChrome] = [
            TableChrome(),
            TableChrome(safeArea: notch, topBar: 70, cornerButton: CGSize(width: 96, height: 52)),
            TableChrome(safeArea: notch, topBar: 75.5, cornerButton: CGSize(width: 80, height: 50.5), bottomBar: 45),
            TableChrome(safeArea: side, topBar: 75.5, cornerButton: CGSize(width: 80, height: 50.5)),
            TableChrome(safeArea: duo, topBar: 75.333, cornerButton: CGSize(width: 79.667, height: 50.333), bottomBar: 45),
        ]
        var tabletop = TableChrome(safeArea: TableInsets(top: 24, left: 0, bottom: 20, right: 0), topBar: 70,
                                   cornerButton: CGSize(width: 96, height: 52))
        tabletop.fold = CGRect(x: -400, y: -10, width: 800, height: 20)
        out.append(tabletop)
        var strip = TableChrome(safeArea: TableInsets(top: 32, left: 0, bottom: 20, right: 0), topBar: 75.5,
                                cornerButton: CGSize(width: 80, height: 50.5))
        strip.occlusions = [CGRect(x: -700, y: -700, width: 32, height: 1400)]
        out.append(strip)
        return out
    }

    /// Every output of `L`, in full precision.
    static func describe(_ L: TableLayout) -> String {
        var p: [String] = ["\(L.handScale)", "\(L.trickScale)", "\(L.mode)", "\(L.isDegraded)", "\(L.usedBottomBar)", "\(L.foldIgnored)",
                           "\(L.safeRect)", "\(L.topLimit)", "\(L.cornerRects)", "\(L.occludedLeft)", "\(L.occludedRight)",
                           "\(L.handBaseline)", "\(L.handTop)", "\(L.liftTop)", "\(L.trickCardSize)", "\(L.historyOrigin)",
                           "\(L.historySpacing)", "\(L.boreBadgeCenter)", "\(L.overTrumpCenter)", "\(L.bidBand)", "\(L.accessory)",
                           "\(L.seatRow)", "\(L.bidPanelBottomInset)", "\(L.chatMaxWidth)", "\(L.window(L.bidBand))",
                           "\(L.window(L.safeRect))", "\(L.handOverlap(count: 13))", "\(L.handSlots(count: 13))",
                           "\(L.myPipsCenter(slots: 13))", "\(L.myPipsCenter(slots: 5))"]
        for r in [Rel.top, .left, .right, .bottom] {
            p += ["\(L.seatAnchor(r))", "\(L.trickSlot(r))", "\(L.trickEntry(r))", "\(L.bubbleAnchor(r))",
                  "\(L.chatPosition(r, bubbleSize: CGSize(width: 150, height: 40)))", "\(L.rainbowCenter(r))"]
        }
        for spectating in [false, true] {
            let b = L.spectatorBadge(spectating: spectating)
            p += ["\(b)", "\(L.spectatorBubbleCenter(badge: b, bubbleSize: CGSize(width: 150, height: 40), spectating: spectating))",
                  "\(String(describing: L.disconnectBanner(height: 60, spectating: spectating)))"]
        }
        return p.joined(separator: "|")
    }

    /// FNV-1a 64 of every pane's description, and how many layouts it covers.
    static func digest() -> (hash: String, count: Int) {
        var h: UInt64 = 0xcbf29ce484222325
        var n = 0
        for size in sizes {
            for chrome in chromes {
                for byte in ("\(size)#" + describe(TableLayout(size: size, chrome: chrome))).utf8 {
                    h ^= UInt64(byte)
                    h = h &* 0x100000001b3
                }
                n += 1
            }
        }
        return (String(h, radix: 16), n)
    }
}
