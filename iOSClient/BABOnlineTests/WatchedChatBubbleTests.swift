import XCTest
import SpriteKit
@testable import BAB_Online

/// The watched player's chat bubble in the over-the-shoulder view (TableLayout+WatchedChat,
/// `SKChatBubbleManager.showWatched`): never on the watched hand (#371's live check: "third line"
/// hid the corner indices of 8♥, 10♥ and 10♣ on the iPhone 18 Pro), beside the watched seat's
/// row where there is room, and clear of the /help column's cards, which SwiftUI draws over the
/// scene.
@MainActor
final class WatchedChatBubbleTests: XCTestCase {
    /// A one-line bubble and the widest two-line one (13 pt, `SKChatBubbleManager.makeBubble`).
    private let sizes = [CGSize(width: 76, height: 27), CGSize(width: 252, height: 42)]

    /// The /help column on a phone as AssistLayout lays it out for a watcher: the safe area less
    /// its 16 pt sides, from under the partner's seat down to the watched seat's row (play) or to
    /// the read-only sheet's clock (bidding). Scene coordinates.
    private func column(_ L: TableLayout, bidding: Bool) -> CGRect {
        let top = L.seatFootprint(.top).minY - TableLayout.gap
        let bottom = bidding ? L.bidBand.maxY + TableLayout.bidClockPillBox.height : L.seatRow.content.maxY
        return CGRect(x: L.safeRect.minX + 16, y: bottom, width: max(0, L.safeRect.width - 32), height: max(0, top - bottom))
    }

    private func watcherLayouts() -> [(String, TableLayout)] {
        SeatExtrasTests.devices.compactMap { name, size, chrome, _, _ in
            // a watcher's table always has its pill at the bottom
            var c = chrome
            if c.bottomBar == 0 { c.bottomBar = 54 }
            let L = TableLayout(size: size, chrome: c)
            return L.isDegraded ? nil : (name, L)
        }
    }

    func testTheWatchedPlayersBubbleIsNeverOnTheHand() {
        for (name, L) in watcherLayouts() {
            for bidding in [false, true] {
                for col in [nil, column(L, bidding: bidding)] {
                    for s in sizes {
                        let tag = "\(name) \(bidding ? "bidding" : "playing") \(col == nil ? "" : "column ")\(Int(s.width))"
                        let ctx = SKChatBubbleManager.WatchedChat(bidding: bidding, column: col)
                        let r = SKChatBubbleManager.watchedRect(L, size: s, context: ctx)
                        // the hand's frame and the band a card lifts into (its dealer button and eye)
                        XCTAssertFalse(TableLayout.overlaps(r, L.watchedHandBand), "\(tag): on the hand \(r) \(L.watchedHandBand)")
                        XCTAssertGreaterThanOrEqual(r.minY, L.liftTop, "\(tag): on the hand")
                        XCTAssertGreaterThanOrEqual(r.minX, L.safeRect.minX - 0.01, "\(tag): off the left edge")
                        XCTAssertLessThanOrEqual(r.maxX, L.safeRect.maxX + 0.01, "\(tag): off the right edge")
                        XCTAssertLessThanOrEqual(r.maxY, L.topLimit + 0.01, "\(tag): under the score bar")
                        // where a spot keeps clear of the watched seat's row, the mic and eye, the
                        // read-only sheet and the /help column, it takes one
                        guard L.watchedChatRect(bubbleSize: s, bidding: bidding, column: col, tier: .tricks) != nil else { continue }
                        let cluster = L.watcherCluster(bidding: bidding)
                        var keeps: [(String, CGRect)] = [("row", L.seatRow.content), ("eye", cluster.badge), ("mic", cluster.voice),
                                                         ("pill", L.bottomBarRect)]
                        if let col { keeps.append(("column", col)) }
                        if bidding { keeps += L.bidSheetKeeps.map { ("sheet", $0) } }
                        for (what, k) in keeps {
                            XCTAssertFalse(TableLayout.overlaps(r, k), "\(tag): over the \(what) \(r) \(k)")
                        }
                    }
                }
            }
        }
    }

    func testOnAPhoneItSitsBesideTheWatchedSeatsRowAboveTheHand() throws {
        // the iPhone 17 / 18 Pro pane (402 x 874) with the watcher's pill, playing
        let (_, size, chrome, _, _) = SeatExtrasTests.devices.first { $0.0 == "iPhone 17 Pro" }!
        var c = chrome
        c.bottomBar = 54
        let L = TableLayout(size: size, chrome: c)
        let row = L.seatRow.content
        let cluster = L.watcherCluster(bidding: false)
        func show(_ line: String, column col: CGRect?) throws -> CGRect {
            let manager = SKChatBubbleManager(layer: SKNode())
            manager.showWatched(position: 3, message: line, context: .init(bidding: false, column: col), layout: L, animator: HoldingAnimator())
            let b = try XCTUnwrap(manager.bubbles[3])
            return CGRect(x: b.node.position.x - b.size.width / 2, y: b.node.position.y - b.size.height / 2, width: b.size.width, height: b.size.height)
        }
        // a short line, with and without the /help column up: in the watched seat's band, above
        // the hand, left of its row, clear of everything (the piles on its left included)
        for col in [nil, column(L, bidding: false)] {
            let r = try show("third line", column: col)
            let tag = col == nil ? "short" : "short, column"
            XCTAssertNotNil(L.watchedChatRect(bubbleSize: r.size, bidding: false, column: col, tier: .clear), "\(tag): clear of everything")
            XCTAssertLessThanOrEqual(r.maxX, row.minX, "\(tag): left of the row: \(r) \(row)")
            XCTAssertLessThan(r.minY, row.maxY, "\(tag): level with the row: \(r) \(row)")
            XCTAssertGreaterThanOrEqual(r.minY, L.liftTop, "\(tag): above the hand")
            let m = TrickHistoryNode.borderPad + 2
            XCTAssertFalse(TableLayout.overlaps(r, L.historyRect.insetBy(dx: -m, dy: -m)), "\(tag): over the piles")
        }
        // a long line: clear of everything without the column; with it (it ends at the row's top,
        // and the piles fill the band beside the row) still never on the hand, the row, the mic
        // and eye or under the column
        let long = "a forty character line that wraps around"
        let free = try show(long, column: nil)
        XCTAssertNotNil(L.watchedChatRect(bubbleSize: free.size, bidding: false, column: nil, tier: .clear), "long: clear of everything")
        let col = column(L, bidding: false)
        let r = try show(long, column: col)
        // (over the piles beside the row at worst: never the trick cards or a seat)
        let tricks = [Positions.RelativePosition.top, .left, .right, .bottom].map { ("trick card", L.trickRect($0)) }
        let seats = [Positions.RelativePosition.top, .left, .right].map { ("seat", L.seatFootprint($0)) }
        for (what, k) in [("hand", L.watchedHandBand), ("row", row), ("eye", cluster.badge), ("mic", cluster.voice), ("column", col)] + tricks + seats {
            XCTAssertFalse(TableLayout.overlaps(r, k), "long, column: over the \(what) \(r) \(k)")
        }
    }

    func testTheBubbleMovesClearWhenTheHelpColumnComesUp() throws {
        let (_, size, chrome, _, _) = SeatExtrasTests.devices.first { $0.0 == "iPhone 17 Pro" }!
        var c = chrome
        c.bottomBar = 54
        let L = TableLayout(size: size, chrome: c)
        let manager = SKChatBubbleManager(layer: SKNode())
        manager.showWatched(position: 2, message: "a long line that wraps over two lines here", context: .init(), layout: L, animator: HoldingAnimator())
        let before = try XCTUnwrap(manager.bubbles[2])
        // a column over the whole table down to the hand (a short pane's): the bubble keeps off it,
        // narrower if it must be (a new node of the new width, in the same layer, the old one gone)
        let col = CGRect(x: L.safeRect.minX, y: L.liftTop + 60, width: L.safeRect.width, height: L.topLimit - L.liftTop - 60)
        manager.setWatchedContext(.init(bidding: false, column: col), layout: L)
        let b = try XCTUnwrap(manager.bubbles[2])
        let r = CGRect(x: b.node.position.x - b.size.width / 2, y: b.node.position.y - b.size.height / 2, width: b.size.width, height: b.size.height)
        XCTAssertFalse(TableLayout.overlaps(r, col), "under the /help column: \(r) \(col)")
        XCTAssertFalse(TableLayout.overlaps(r, L.watchedHandBand), "on the hand: \(r)")
        XCTAssertNotNil(b.node.parent)
        if b.node !== before.node { XCTAssertNil(before.node.parent, "the old bubble is gone") }
        XCTAssertEqual(manager.layer.children.filter { $0.name == "chat.2" }.count, 1, "one bubble")
    }
}
