import SpriteKit
import XCTest
@testable import BAB_Online

/// A chat or bid bubble is one VoiceOver element with the bubble's frame (2026-11-22: a plain
/// SKNode container's frame is empty, so VoiceOver's focus was a point).
final class SpokenGroupNodeTests: XCTestCase {
    func testABubblesFrameIsItsDrawnBoundsWhereverItSits() {
        let (bubble, size) = SKChatBubbleManager.makeBubble("good luck all", maxWidth: 200, name: "chat.2",
                                                            fill: .black, text: .white)
        XCTAssertEqual(bubble.accessibilityLabel, "good luck all")
        XCTAssertTrue(bubble.isAccessibilityElement)
        bubble.position = CGPoint(x: 100, y: 300)
        let f = bubble.frame
        XCTAssertEqual(f.width, size.width, accuracy: 1)
        XCTAssertEqual(f.height, size.height, accuracy: 1)
        XCTAssertEqual(f.midX, 100, accuracy: 1)
        XCTAssertEqual(f.midY, 300, accuracy: 1)
        // the pop-in scales it: the frame follows
        bubble.setScale(0.5)
        XCTAssertEqual(bubble.frame.width, size.width / 2, accuracy: 1)
        XCTAssertEqual(bubble.frame.midX, 100, accuracy: 1)
    }

    func testTheDrawnTextIsNotASecondElement() {
        let (bubble, _) = SKChatBubbleManager.makeBubble("a forty character line that wraps around", maxWidth: 140,
                                                         name: "chat.1", fill: .black, text: .white)
        let label = bubble.children.compactMap { $0 as? SKLabelNode }.first
        XCTAssertNotNil(label)
        XCTAssertEqual(label?.accessibilityLabel, "", "SpriteKit lists a label's text unless it has a label of its own")
        XCTAssertFalse(label?.isAccessibilityElement ?? true)
        XCTAssertEqual(bubble.accessibilityLabel, "a forty character line that wraps around", "the whole line, not the drawn cut")
    }

    func testABidBubbleHasItsFrame() {
        let b = BidBubbleNode(bid: "B")
        b.position = CGPoint(x: 50, y: 60)
        XCTAssertEqual(b.accessibilityLabel, "Bid B")
        XCTAssertGreaterThan(b.frame.width, 40)
        XCTAssertGreaterThan(b.frame.height, 20)
        XCTAssertEqual(b.frame.midX, 50, accuracy: 1)
        XCTAssertEqual(b.frame.midY, 60, accuracy: 1)
    }

    func testAnEmptyGroupIsAPointAtItsPosition() {
        let g = SpokenGroupNode()
        g.position = CGPoint(x: 7, y: 9)
        XCTAssertEqual(g.frame, CGRect(x: 7, y: 9, width: 0, height: 0))
    }
}
