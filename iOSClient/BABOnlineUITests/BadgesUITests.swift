import XCTest

/// Badges in fixture mode (iOS 1.2.7 (41); UIFixture+Profile `-uiBadges`, `-uiBadgesAwarded`):
/// my earned badges below the statistics in the Account sheet, another player's in their
/// profile sheet, "No badges yet.", the largest text size, and the "Badge earned" toast over
/// the score screen (the web's words, queued awards, a tap for the next, inside the screen).
/// Runs on any device (the iPhone 17e, an iPad and the iPhone Duo closed, open and in book
/// pose are the layouts to look at; screenshots are kept as attachments).
final class BadgesUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func openAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let gear = app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        gear.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5), "the Account sheet")
        return app
    }

    /// Brings `e` on screen by swiping the sheet up.
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement, swipes: Int = 8) {
        for _ in 0..<swipes where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
    }

    /// Brings all of `e` on screen: hittable is not enough, a ~136 pt tile can stand half below
    /// the window's edge (the iPhone Duo closed, a 466 x 678 window: iOS 1.2.7 (41)'s release run).
    /// Short drags until its frame is inside the window; players scroll there too.
    private func revealWhole(_ app: XCUIApplication, _ e: XCUIElement) {
        reveal(app, e)
        let window = app.windows.firstMatch.frame
        for _ in 0..<8 where e.exists && e.frame.maxY > window.maxY - 1 {
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -120)))
        }
    }

    private func assertOnScreen(_ app: XCUIApplication, _ e: XCUIElement, _ what: String) {
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -1, dy: -1).contains(e.frame), "\(what) \(e.frame) outside the window \(window)")
    }

    // MARK: - Profiles

    /// The Account sheet: the heading "Badges" below the statistics, my three badges in the
    /// server's order, each one element read as its name and description.
    func testMyBadgesAreBelowMyStatistics() {
        let app = openAccount()
        let stats = element(app, "profile.stats")
        XCTAssertTrue(stats.waitForExistence(timeout: 6))
        let felted = element(app, "profile.badge.felted")
        reveal(app, felted)
        XCTAssertTrue(felted.waitForExistence(timeout: 5), "my first badge")
        XCTAssertEqual(felted.label, "Felted, Ended a game with a negative score.")
        XCTAssertEqual(element(app, "profile.badge.hammer-time").label, "Hammer Time, Held the HI joker 5 times in a game.")
        XCTAssertTrue(element(app, "profile.badge.century").exists)
        XCTAssertTrue(app.staticTexts["Badges"].exists, "the heading")
        if stats.exists, !stats.frame.isEmpty {
            XCTAssertGreaterThan(felted.frame.minY, stats.frame.maxY - 1, "below the statistics")
        }
        for id in ["felted", "hammer-time", "century"] {
            let tile = element(app, "profile.badge.\(id)")
            revealWhole(app, tile)
            assertOnScreen(app, tile, id)
        }
        XCTAssertFalse(element(app, "profile.badgesEmpty").exists)
        shot("badges-account")
        app.terminate()
    }

    /// A server without badges (no field) or an account with none: "No badges yet."; an id with
    /// no art in this build still shows its name, a malformed one is dropped.
    func testNoBadgesAndUnknownOnes() {
        var app = openAccount(["-uiBadges", "absent"])
        let empty = element(app, "profile.badgesEmpty")
        reveal(app, empty)
        XCTAssertTrue(empty.waitForExistence(timeout: 6))
        XCTAssertEqual(empty.label, "No badges yet.")
        app.terminate()

        app = openAccount(["-uiBadges", "unknown"])
        let unknown = element(app, "profile.badge.brand-new-badge")
        reveal(app, unknown)
        XCTAssertTrue(unknown.waitForExistence(timeout: 6))
        XCTAssertEqual(unknown.label, "Brand New, A badge this build has no art for.")
        XCTAssertFalse(app.staticTexts["Dropped"].exists)
        shot("badges-unknown")
        app.terminate()
    }

    /// The largest text size: one badge a row, the picture beside the words, every row inside
    /// the screen.
    func testMyBadgesAtTheLargestTextSize() {
        let app = openAccount(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let felted = element(app, "profile.badge.felted"), hammer = element(app, "profile.badge.hammer-time")
        reveal(app, hammer, swipes: 14)
        XCTAssertTrue(hammer.waitForExistence(timeout: 6))
        reveal(app, felted, swipes: 0)
        if felted.exists {
            XCTAssertGreaterThan(hammer.frame.minY, felted.frame.maxY - 1, "one badge a row")
        }
        // a swipe can stop with the ~340 pt row half in view (the Tournaments section above it,
        // 1.2.7, moved where the swipes end): short drags until all of it is on screen
        let window = app.windows.firstMatch.frame
        for _ in 0..<8 where hammer.frame.maxY > window.maxY - 20 {
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
        }
        assertOnScreen(app, hammer, "hammer-time")
        shot("badges-account-ax5")
        app.terminate()
    }

    /// Another player's profile (the online list): kim's seven badges below the statistics;
    /// a player with none says so.
    func testAnotherPlayersBadges() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let online = app.buttons.matching(NSPredicate(format: "label == %@", "7 online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 5))
        online.tap()
        XCTAssertTrue(app.navigationBars["Players"].waitForExistence(timeout: 5))
        var row = element(app, "online.kim")
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        row.tap()
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 6))
        let chemistry = element(app, "profile.badge.chemistry")
        reveal(app, chemistry)
        XCTAssertTrue(chemistry.waitForExistence(timeout: 5))
        XCTAssertEqual(chemistry.label, "Chemistry, Played 20 games with the same partner.")
        XCTAssertTrue(element(app, "profile.badge.five-hundred").exists)
        revealWhole(app, chemistry)
        assertOnScreen(app, chemistry, "chemistry")
        shot("badges-player-kim")
        element(app, "profile.close").tap()

        row = element(app, "online.ora")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        let empty = element(app, "profile.badgesEmpty")
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 6))
        reveal(app, empty)
        XCTAssertTrue(empty.waitForExistence(timeout: 5), "ora has none")
        app.terminate()
    }

    // MARK: - The toast

    private func gameEnd(_ extra: [String]) -> XCUIApplication {
        let app = Fixture.launch("game-end", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "game-end").waitForExistence(timeout: 20), "game-end did not come up")
        XCTAssertTrue(element(app, "gameEnd.title").waitForExistence(timeout: 10), "the score screen")
        return app
    }

    /// Over the score screen: the first award's toast (the web's words, its pictures), a tap
    /// shows the second, queued behind it; a tap on that one leaves the score screen as it was.
    func testTheToastOverTheScoreScreenQueuesAwards() {
        let app = gameEnd(["-uiBadgesAwarded", "YES"])
        let toast = element(app, "badgeToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8), "the badge toast")
        XCTAssertEqual(toast.label, "Badges earned: Felted, Hurt People Mode")
        assertOnScreen(app, toast, "the toast")
        XCTAssertTrue(element(app, "gameEnd.title").exists, "over the score screen")
        shot("badges-toast-two")
        toast.tap()
        let next = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@",
                                                                       "badgeToast", "Badge earned: Century")).firstMatch
        XCTAssertTrue(next.waitForExistence(timeout: 5), "the queued award")
        assertOnScreen(app, next, "the second toast")
        shot("badges-toast-next")
        next.tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: element(app, "badgeToast"))
        waitForExpectations(timeout: 5)
        XCTAssertTrue(element(app, "gameEnd.title").exists, "the score screen stays")
        app.terminate()
    }

    /// Five badges in one award: every name in the words, inside the screen at the largest
    /// text size it allows.
    func testManyBadgesAtTheLargestTextSize() {
        let app = gameEnd(["-uiBadgesAwarded", "many", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let toast = element(app, "badgeToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8))
        XCTAssertEqual(toast.label, "Badges earned: Felted, Hurt People Mode, In the Red, Choke Artist, Exact Tie")
        assertOnScreen(app, toast, "the toast")
        shot("badges-toast-many-ax5")
        app.terminate()
    }

    /// The iPad in landscape and the Duo's book pose (`-uiFold book`): the toast stays on one
    /// page, never across the fold.
    func testTheToastKeepsOffABookFold() {
        let app = gameEnd(["-uiBadgesAwarded", "many", "-uiFold", "book"])
        let toast = element(app, "badgeToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8))
        let window = app.windows.firstMatch.frame
        // the synthetic fold: 20 pt at the window's centre
        let fold = CGRect(x: window.midX - 10, y: window.minY, width: 20, height: window.height)
        if window.width - 20 >= 2 * 240 {
            XCTAssertFalse(toast.frame.intersects(fold), "toast \(toast.frame) across the fold \(fold)")
        }
        assertOnScreen(app, toast, "the toast")
        shot("badges-toast-book")
        app.terminate()
    }
}
