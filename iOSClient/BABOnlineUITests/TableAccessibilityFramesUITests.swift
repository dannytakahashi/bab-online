import XCTest

/// Every table element VoiceOver can reach has a frame on screen (2026-11-22: chat bubbles and bid
/// bubbles were plain SKNode containers, whose VoiceOver frame is empty, so the focus was a point),
/// and a bubble is ONE element reading its whole line (its SKLabelNode's text was listed too).
final class TableAccessibilityFramesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func labelled(_ app: XCUIApplication) -> [(label: String, frame: CGRect)] {
        app.descendants(matching: .any).allElementsBoundByIndex
            .compactMap { e in e.label.isEmpty ? nil : (e.label, e.frame) }
    }

    private func check(_ fixture: String, _ extra: [String], bubbles: [String], bids: [String] = []) {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 2)  // the bubbles' pop-in
        let all = labelled(app)
        let window = app.windows.firstMatch.frame
        for (label, f) in all where f.width < 1 || f.height < 1 {
            XCTFail("\(fixture): \"\(label)\" has an empty frame \(f)")
        }
        for line in bubbles + bids {
            let hits = all.filter { $0.label == line }
            XCTAssertEqual(hits.count, 1, "\(fixture): one element reads \"\(line)\": \(hits)")
            if let f = hits.first?.frame {
                XCTAssertTrue(window.contains(f), "\(fixture): \"\(line)\" on screen \(f)")
                XCTAssertGreaterThanOrEqual(f.height, 20, "\(fixture): \"\(line)\" is the bubble's frame, not a point \(f)")
            }
        }
        // the bubble's drawn text is not listed apart from it
        for line in bubbles {
            let words = line.split(separator: " ").prefix(2).joined(separator: " ")
            let partial = all.filter { $0.label != line && $0.label.hasPrefix(words) && !$0.label.contains(": ") }
            XCTAssertTrue(partial.isEmpty, "\(fixture): stray text for \"\(line)\": \(partial)")
        }
        app.terminate()
    }

    func testChatBubblesAreOneElementWithTheirFrame() {
        check("trick-mid-lead3", ["-uiChat", "2|good luck all;zach|nice one"], bubbles: ["good luck all", "zach: nice one"])
    }

    func testBidBubblesAndChatWhileBidding() {
        check("bidding-mid", ["-uiChat", "3|hmm"], bubbles: ["hmm"], bids: ["Bid 1", "Bid B"])
    }

    func testTheWatchedPlayersLongLine() {
        // cut to two lines on a narrow bubble; the element still reads the whole line
        check("spectator-mid-hand", ["-uiShoulder", "auto", "-uiChat", "1|a forty character line that wraps around"],
              bubbles: ["a forty character line that wraps around"])
    }
}
