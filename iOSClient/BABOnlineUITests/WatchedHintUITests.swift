import XCTest

/// The over-the-shoulder view's mirrored hint cards (owner 2026-11-21; docs/claude/spectators.md
/// "Over-the-shoulder view"), in fixture mode: `-uiWatchedHint <name>` (UIFixture+WatchedHint)
/// draws the column's cards as a watched seat's copies and pushes its rule tip and its /help
/// answer (counted, the 4th use: my own card would say "Help 4: this game counts as
/// bot-assisted for you"). The cards name the player ("Alice's advice", "Alice's tip"), show no
/// count anywhere, VoiceOver says whose they are, the heading never cuts the chip or the title
/// at the largest type size, and closing them sends nothing ("fixture.sent").
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs (`TEST_RUNNER_BAB_SHOT_TAG=<tag>` names them).
final class WatchedHintUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private static let ax2 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
    /// Above the cards' cap (accessibility2): drawn as accessibility2.
    private static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    /// A long username (20 characters, the sign-up limit).
    private static let longName = "Bartholomew_Christo2"

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        let env = ProcessInfo.processInfo.environment
        if let dir = env["BAB_SHOTS"], !dir.isEmpty {
            let tag = env["BAB_SHOT_TAG"].map { "-\($0)" } ?? ""
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("watched-\(name)\(tag).png"))
        }
    }

    private func launch(_ fixture: String, name: String = "Alice", _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: ["-uiWatchedHint", name] + extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 6), "the watched advice")
        XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 6), "the watched tip")
        Thread.sleep(forTimeInterval: 0.5)  // the column's scroll settles
        return app
    }

    /// The words my own card would show for the watched player's counts, which the copy carries.
    private let countWords = ["Help ", "free", "Free", "counted", "Counted", "bot-assisted", "unlimited", " of 3"]

    private func assertNoCounts(_ app: XCUIApplication, _ tag: String) {
        for card in ["assistCard", "tutorialTip"] {
            let texts = element(app, card).descendants(matching: .staticText).allElementsBoundByIndex.map(\.label)
            XCTAssertFalse(texts.isEmpty, "\(tag): \(card) has texts")
            for t in texts {
                for w in countWords { XCTAssertFalse(t.contains(w), "\(tag): \(card) shows \"\(t)\"") }
            }
            for w in countWords { XCTAssertFalse(element(app, card).label.contains(w), "\(tag): \(card) label") }
        }
        XCTAssertFalse(element(app, "assist.note").exists, "\(tag): no note")
        XCTAssertFalse(app.buttons["tip.keep"].exists)
        XCTAssertFalse(app.buttons["tip.off"].exists)
    }

    /// `inner` lies inside `outer` (1 pt slack).
    private func inside(_ inner: CGRect, _ outer: CGRect) -> Bool { outer.insetBy(dx: -1, dy: -1).contains(inner) }

    /// The advice's heading, chip, headline and close in sight, inside the card and the screen,
    /// none over another; the tip's heading, title and close likewise (where the tip is
    /// scrolled up the pinned head's).
    private func fits(_ app: XCUIApplication, _ tag: String) {
        let screen = app.windows.firstMatch.frame
        let card = element(app, "assistCard").frame
        let heading = element(app, "assist.watched")
        let chip = element(app, "assist.confidence")
        let headline = element(app, "assist.headline")
        let close = app.buttons["assist.close"]
        for (n, e) in [("heading", heading), ("chip", chip), ("headline", headline), ("close", close)] {
            XCTAssertTrue(e.waitForExistence(timeout: 3), "\(tag): advice \(n)")
            XCTAssertTrue(inside(e.frame, card), "\(tag): advice \(n) \(e.frame) outside the card \(card)")
            XCTAssertTrue(inside(e.frame, screen), "\(tag): advice \(n) \(e.frame) off the screen \(screen)")
            XCTAssertGreaterThan(e.frame.width, 4, "\(tag): advice \(n) has a width")
        }
        XCTAssertFalse(heading.frame.intersects(chip.frame), "\(tag): heading \(heading.frame) over chip \(chip.frame)")
        XCTAssertFalse(heading.frame.intersects(close.frame), "\(tag): heading \(heading.frame) over close \(close.frame)")
        XCTAssertFalse(chip.frame.intersects(close.frame), "\(tag): chip over close")
        XCTAssertGreaterThanOrEqual(headline.frame.minY, max(heading.frame.maxY, chip.frame.maxY) - 1, "\(tag): headline under the top rows")
        XCTAssertTrue(close.isHittable, "\(tag): advice close")

        let pinned = element(app, "tip.pinned")
        let prefix = pinned.exists ? "tip.pinned" : "tip."
        let tipHeading = element(app, pinned.exists ? "tip.pinnedWatched" : "tip.watched")
        let title = element(app, pinned.exists ? "tip.pinnedTitle" : "tip.title")
        let tipClose = app.buttons[pinned.exists ? "tip.pinnedClose" : "tip.close"]
        for (n, e) in [("heading", tipHeading), ("title", title), ("close", tipClose)] {
            XCTAssertTrue(e.waitForExistence(timeout: 3), "\(tag): tip \(n) (\(prefix))")
            XCTAssertTrue(inside(e.frame, screen), "\(tag): tip \(n) \(e.frame) off the screen")
        }
        XCTAssertFalse(tipHeading.frame.intersects(tipClose.frame), "\(tag): tip heading over its close")
        XCTAssertGreaterThanOrEqual(title.frame.minY, tipHeading.frame.maxY - 1, "\(tag): the title under the heading")
        // (XCUITest calls the pinned row's buttons not hittable, the scroll view under the
        // overlay answering its hit test; a tap there lands on them: TutorialUITests.tipButton)
        if !pinned.exists { XCTAssertTrue(tipClose.isHittable, "\(tag): tip close") }
    }

    /// My bid turn: both cards name Alice, the footer is the plain one, VoiceOver says whose
    /// they are, and the two closes send nothing.
    func testTheWatchedCardsNameThePlayerShowNoCountsAndSendNothing() {
        let app = launch("bidding-mid")
        XCTAssertEqual(element(app, "assist.watched").label, "Alice's advice")
        XCTAssertEqual(element(app, "tip.watched").label, "Alice's tip")
        XCTAssertEqual(element(app, "assistCard").label, "Suggestion for Alice")
        XCTAssertEqual(element(app, "tutorialTip").label, "Tip for Alice")
        XCTAssertEqual(element(app, "assist.headline").label, "Bid 2")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Bidding")
        assertNoCounts(app, "bid")
        fits(app, "bid default")
        shot(app, "bid")
        // closes: local only
        let tipClose = element(app, "tip.pinned").exists ? app.buttons["tip.pinnedClose"] : app.buttons["tip.close"]
        tipClose.tap()
        XCTAssertTrue(element(app, "tutorialTip").waitForNonExistence(timeout: 3))
        app.buttons["assist.close"].tap()
        XCTAssertTrue(element(app, "assistCard").waitForNonExistence(timeout: 3))
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "-", "nothing sent for either close")
    }

    /// My play turn: the card advice, and a Quick suggestion's footer is the Quick note alone.
    func testOnAPlayTurnAndAQuickSuggestion() {
        let app = launch("trick-mid-lead3", ["-uiWatchedHintQuick", "YES"])
        XCTAssertEqual(element(app, "assist.watched").label, "Alice's advice")
        XCTAssertTrue(element(app, "assist.headline").label.hasPrefix("Play "), element(app, "assist.headline").label)
        XCTAssertEqual(element(app, "assist.confidence").label, "Quick suggestion")
        XCTAssertEqual(element(app, "assist.footer").label, "Quick suggestion: rules only, the server is busy.")
        assertNoCounts(app, "play")
        fits(app, "play default")
        shot(app, "play-quick")
    }

    /// accessibility2 (the cards' cap) and above it, with a 20-character name: the heading falls
    /// back to its own line where it must, never cutting the chip, the headline or the title.
    func testTheHeadingFitsAtTheLargestTypeWithALongName() {
        for (size, extra) in [("ax2", Self.ax2), ("ax5", Self.ax5)] {
            let app = launch("bidding-mid", name: Self.longName, extra)
            // the whole name reaches VoiceOver even where the line cuts it
            XCTAssertEqual(element(app, "assist.watched").label, "\(Self.longName)'s advice", size)
            XCTAssertEqual(element(app, "tip.watched").label, "\(Self.longName)'s tip", size)
            XCTAssertEqual(element(app, "assistCard").label, "Suggestion for \(Self.longName)", size)
            assertNoCounts(app, size)
            fits(app, "long \(size)")
            shot(app, "long-\(size)")
            app.terminate()
        }
        let app = launch("bidding-mid", name: "Alice", Self.ax2)
        fits(app, "Alice ax2")
        shot(app, "bid-ax2")
    }
}
