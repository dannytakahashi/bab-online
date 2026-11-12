import XCTest

/// VoiceOver at the table (1.2.0 (3) polish): the scene's drawing nodes (pip
/// dots, the pips' box and bore outline, the trick piles' slots, icons and
/// borders) are not in the accessibility tree at all, the SwiftUI pips
/// elements speak the counts, and the score bar's bid icon is part of a "Bid
/// 2/4" element instead of its own "Target With Concentric Rings" element.
///
/// Note: on iOS 27 the XCUITest tree also lists the children of a combined
/// element and images marked accessibilityHidden (e.g. the Leave button's
/// symbol under "Leave game", the lobby's "trophy.fill"); VoiceOver does not
/// visit them. So these checks look at structure: which element an icon sits in.
final class TableAccessibilityTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    /// Every element's (identifier, label) in the app's tree.
    private func elements(_ app: XCUIApplication) -> [(id: String, label: String)] {
        app.descendants(matching: .any).allElementsBoundByIndex.map { ($0.identifier, $0.label) }
    }

    /// A SpriteKit drawing node's name that must not reach the accessibility tree.
    static func isDrawingNode(_ s: String) -> Bool {
        let patterns = [#"^pip\.\d+$"#, #"^pips$"#, #"^pips\.(box|bore)$"#, #"^history\.(team|opp)\.slot\.\d+$"#,
                        #"^history\.(team|opp)\.border$"#, #"^history\.(team|opp)\.\d+$"#, #"^history$"#]
        return patterns.contains { s.range(of: $0, options: .regularExpression) != nil }
    }

    private func check(_ app: XCUIApplication, _ tag: String) {
        let all = elements(app)
        let dump = all.map { "\($0.id) | \($0.label)" }.joined(separator: "\n")
        let a = XCTAttachment(string: dump)
        a.name = "a11y-\(tag)"
        a.lifetime = .keepAlways
        add(a)
        let raw = all.filter { Self.isDrawingNode($0.id) || Self.isDrawingNode($0.label) }
        XCTAssertEqual(raw.count, 0, "\(tag): raw node elements \(raw.prefix(12).map { $0.id.isEmpty ? $0.label : $0.id })")
        // "pips.mine" / "pips.<n>" are only the SwiftUI elements, each speaking a count
        // (the scene's own "pips.mine" node made the identifier ambiguous)
        for e in all where e.id == "pips.mine" || e.label == "pips.mine" || e.id.range(of: #"^pips\.\d$"#, options: .regularExpression) != nil {
            XCTAssertTrue(e.label.contains("trick") || e.label.contains("bore"), "\(tag): \(e.id) reads \"\(e.label)\"")
        }
        // the bid icon: every "target" image sits inside a "Bid ..." element (VoiceOver reads that one)
        let bids = app.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Bid '"))
        let inBids = bids.allElementsBoundByIndex.reduce(0) { $0 + $1.images.matching(identifier: "target").count }
        XCTAssertEqual(app.images.matching(identifier: "target").count, inBids, "\(tag): a bid icon outside its Bid element")
        // the Leave / Exit icon sits inside the one "Leave game" / "Exit game" button
        let leave = app.buttons["leave"]
        XCTAssertTrue(["Leave game", "Exit game"].contains(leave.label), "\(tag): \(leave.label)")
        XCTAssertEqual(app.images.matching(identifier: "rectangle.portrait.and.arrow.right").count,
                       leave.images.matching(identifier: "rectangle.portrait.and.arrow.right").count, "\(tag): the Leave icon outside its button")
    }

    func testSeatedTableHasNoRawNodeElements() {
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        check(app, "trick-mid-lead3")
        // the seats' pips labels (every seat bid 1+), singular for one trick
        XCTAssertTrue(app.otherElements["pips.mine"].label.hasPrefix("Your tricks: "))
        XCTAssertEqual(app.otherElements["pips.2"].label, "kim: 0 of 1 trick")
        XCTAssertEqual(app.otherElements["pips.3"].label, "hal: 0 of 4 tricks")
        // the bid totals read "Bid ..."
        XCTAssertEqual(app.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Bid '")).count, 2)
        XCTAssertTrue(app.otherElements["Bid 2/4"].exists)
        XCTAssertEqual(app.buttons["leave"].label, "Leave game")
        app.terminate()
    }

    func testSpectatorTableHasNoRawNodeElements() {
        let app = Fixture.launch("spectator-mid-hand")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        check(app, "spectator-mid-hand")
        XCTAssertEqual(app.buttons["leave"].label, "Exit game")
        XCTAssertEqual(app.otherElements["pips.1"].label, "ivy: 0 of 2 tricks")
        app.terminate()
    }
}
