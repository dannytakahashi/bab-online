import XCTest

/// Cut for a buck on iOS 1.2.7 (41), fixture mode (`tournament-cut -uiCut "<n> <stage>"`,
/// UIFixture+Cut): every stage's screen, the ring's layout probe ("cut.layoutCheck") for 2 to 20
/// players, the deck's draw and the tap after the server drew for me (in "fixture.sent"), the flip
/// and verdict, an out player still watching, the winner, the final lobby, a spectator, the list
/// at the largest text size, the intro (and its Reduce Motion form), and the score screen's strip.
/// Runs on every device of the UI plan (phones, the iPad, the Duo closed / open / book pose).
final class CutForABuckUITests: XCTestCase {
    static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func setUp() {
        continueAfterFailure = false
    }

    private var device: String {
        (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "device").replacingOccurrences(of: " ", with: "_")
    }

    private func keep(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "cut-\(device)-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func open(_ n: Int, _ stage: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("tournament-cut", extra: ["-uiCut", "\(n) \(stage)"] + extra)
        XCTAssertTrue(Fixture.readyElement(app, "tournament-cut").waitForExistence(timeout: 20), "the tournament lobby")
        return app
    }

    private func label(_ e: XCUIElement) -> String { e.label }

    private func waitFor(_ timeout: TimeInterval = 6, _ what: String, _ check: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTFail("timed out: \(what)")
    }

    private func assertInside(_ app: XCUIApplication, _ e: XCUIElement, _ what: String) {
        let w = app.windows.firstMatch.frame
        let f = e.frame
        XCTAssertTrue(f.minX >= w.minX - 0.5 && f.maxX <= w.maxX + 0.5 && f.minY >= w.minY - 0.5 && f.maxY <= w.maxY + 0.5,
                      "\(what) \(f) outside \(w)")
    }

    // MARK: - The ring

    func testTheRingFitsFromTwoToTwentyPlayers() {
        for n in [2, 4, 8, 12, 16, 20] {
            let app = open(n, "drawing", ["-uiCutView", "ring"])
            let check = Fixture.probe(app, "cut.layoutCheck")
            XCTAssertTrue(check.hasPrefix("ok n=\(n) "), "\(n) players: \(check)")
            if n >= 3 {
                let me = any(app, "cut.seat.ivy")
                XCTAssertTrue(me.waitForExistence(timeout: 5))
                assertInside(app, me, "my seat")
                // I sit at 6 o'clock: no seat lower than mine
                let others = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cut.seat.'")).allElementsBoundByIndex
                XCTAssertEqual(others.count, n)
                for o in others { XCTAssertLessThanOrEqual(o.frame.midY, me.frame.midY + 1, o.identifier); assertInside(app, o, o.identifier) }
            }
            assertInside(app, any(app, "cut.deck"), "the deck")
            if [8, 20].contains(n) { keep("ring-\(n)") }
            app.terminate()
        }
    }

    func testATapOnTheDeckDrawsAndTheCardsFlipTogether() {
        let app = open(6, "drawing", ["-uiCutView", "ring", "-uiCutPlay", "YES"])
        XCTAssertEqual(any(app, "cut.status").label, "Tap the deck to draw")
        XCTAssertTrue(any(app, "cut.statusSub").label.hasPrefix("Auto-draw in"))
        let deck = any(app, "cut.deck")
        XCTAssertEqual(deck.label, "Draw a card")
        XCTAssertTrue(deck.value as? String ?? "" == "48 cards left" || (deck.value as? String ?? "").hasSuffix("cards left"))
        keep("drawing")
        deck.tap()
        waitFor(3, "the draw went out") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:3:") }
        // the others draw, the cards flip, then the verdict
        waitFor(8, "the verdict") { any(app, "cut.status").label == "You're safe with a 9" }
        keep("verdict")
        XCTAssertEqual(any(app, "cut.seat.ivy").value as? String, "idle")
        let sent = Fixture.probe(app, "fixture.sent")
        XCTAssertEqual(sent.components(separatedBy: "cutForABuckDraw").count - 1, 1, "one draw a round: \(sent)")
        // the next round: my draw is open again, and a tap draws again
        waitFor(8, "round 4 opens") { any(app, "cut.status").label == "Tap the deck to draw" }
        XCTAssertTrue(any(app, "cut.round").label.hasPrefix("Round 4"))
        deck.tap()
        waitFor(3, "the second draw went out") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:4:") }
        waitFor(8, "the second verdict") { any(app, "cut.status").label == "You're safe with a 9" && any(app, "cut.round").label.hasPrefix("Round 4") }
    }

    func testAfterTheServerDrewForMeATapSaysIAmBack() {
        let app = open(8, "away")
        XCTAssertEqual(any(app, "cut.statusSub").label, "We drew a card for you")
        any(app, "cut.deck").tap()
        waitFor(3, "the say-back") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:3:null") }
        any(app, "cut.deck").tap()
        sleep(1)
        XCTAssertEqual(Fixture.probe(app, "fixture.sent").components(separatedBy: "cutForABuckDraw").count - 1, 1, "once a round")
        keep("away")
    }

    func testAnOutPlayerKeepsWatchingTheNextRound() {
        let app = open(8, "out", ["-uiCutView", "ring"])
        XCTAssertEqual(any(app, "cut.status").label, "You're out. Watching the rest")
        XCTAssertTrue(any(app, "cut.statusSub").label.hasPrefix("Waiting for "))
        XCTAssertTrue(any(app, "cut.seat.ivy").label.hasPrefix("you, out in round 4"))
        XCTAssertEqual(any(app, "cut.seat.kim").value as? String, "drawn", "kim's draw this round shows")
        XCTAssertEqual(any(app, "cut.deck").label, "Draw a card")
        XCTAssertTrue(any(app, "cut.round").label.hasPrefix("Round 5"))
        keep("out")
    }

    func testRevealRedrawAndReshuffle() {
        var app = open(8, "reveal", ["-uiCutView", "ring"])
        XCTAssertEqual(any(app, "cut.status").label, "You're safe with a 9")
        XCTAssertTrue(any(app, "cut.statusSub").label.hasSuffix("are out with 3s"), any(app, "cut.statusSub").label)
        XCTAssertTrue(any(app, "cut.seat.max").label.contains("out in round 3"))
        keep("reveal")
        app.terminate()
        app = open(8, "redraw", ["-uiCutView", "ring"])
        XCTAssertEqual(any(app, "cut.status").label, "Everyone tied on 7s. Redraw!")
        keep("redraw")
        app.terminate()
        app = open(8, "reshuffle", ["-uiCutView", "ring"])
        XCTAssertEqual(any(app, "cut.deckCaption").label, "54 cards left")
        XCTAssertEqual(any(app, "cut.status").label, "Tap the deck to draw")
        keep("reshuffle")
    }

    func testTheWinnerAndTheFinalLobby() {
        var app = open(8, "winner", ["-uiCutView", "ring"])
        let winner = any(app, "cut.winner")
        XCTAssertTrue(winner.waitForExistence(timeout: 5))
        XCTAssertEqual(winner.label, "kim wins cut for a buck!")
        XCTAssertEqual(any(app, "cut.status").label, "kim wins cut for a buck!")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'bragging'")).firstMatch.exists)
        XCTAssertEqual(any(app, "cut.seat.kim").value as? String, "winner")
        keep("winner")
        app.terminate()
        app = open(8, "complete")
        XCTAssertEqual(app.staticTexts["results.winner"].label, "You win the tournament!")
        XCTAssertEqual(any(app, "results.cut").label, "kim won cut for a buck")
        XCTAssertTrue(any(app, "results.player.kim").label.contains("Won the cut"))
        XCTAssertTrue(any(app, "results.player.ivy").label.contains("Winner"))
        XCTAssertTrue(app.staticTexts["This lobby stays open for about 10 minutes"].exists)
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists)
        keep("complete")
        app.buttons["results.return"].tap()
        XCTAssertTrue(any(app, "screen.mainRoom").waitForExistence(timeout: 5))
    }

    func testASpectatorWatches() {
        let app = open(8, "drawing", ["-uiSpectator", "YES", "-uiCutView", "ring"])
        XCTAssertEqual(any(app, "cut.status").label, "Watching cut for a buck")
        let deck = any(app, "cut.deck")
        XCTAssertEqual(deck.label, "Deck")
        deck.tap()
        sleep(1)
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw"))
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists)
        keep("spectator")
    }

    func testTheListAtTheLargestTextSize() {
        let app = open(12, "drawing", Self.ax5)
        let list = any(app, "cut.list")
        XCTAssertTrue(list.waitForExistence(timeout: 5), "the list is the default at the accessibility sizes")
        let draw = app.buttons["cut.listDraw"]
        XCTAssertTrue(draw.waitForExistence(timeout: 5))
        if !draw.isHittable { app.swipeUp() }
        XCTAssertTrue(draw.isHittable)
        keep("list-ax5")
        draw.tap()
        waitFor(3, "the list's draw") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:3:null") }
    }

    func testTheIntroPlaysAndGoes() {
        var app = open(12, "gather", ["-uiCutView", "ring"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3))
        XCTAssertTrue(any(app, "cut.status").label.hasPrefix("Cut for a buck starts in"))
        waitFor(5, "the intro ends") { !any(app, "cut.intro").exists }
        keep("gather")
        app.terminate()
        app = open(12, "gather", ["-uiCutView", "ring", "-uiReduceMotion", "YES"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3))
        waitFor(3, "the reduced intro ends") { !any(app, "cut.intro").exists }
        app.terminate()
        app = open(12, "gather", ["-uiCutView", "ring", "-uiCutIntroFrame", "1.4"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3))
        keep("intro-1.4")
    }

    func testTheScoreScreenStrip() {
        let app = Fixture.launch("game-end-tournament", extra: ["-uiCut", "4 gather"])
        XCTAssertTrue(any(app, "gameEnd").waitForExistence(timeout: 20))
        let strip = any(app, "gameEnd.cutStrip")
        XCTAssertTrue(strip.waitForExistence(timeout: 5))
        XCTAssertTrue(strip.label.contains("Cut for a buck starts in"), strip.label)
        XCTAssertTrue(app.buttons["Join cut for a buck"].isHittable)
        keep("score-strip")
    }

    func testTheListAndTheRingToggle() {
        let app = open(8, "drawing", ["-uiCutView", "ring"])
        XCTAssertTrue(any(app, "cut.ring").exists)
        app.buttons["List"].tap()
        XCTAssertTrue(any(app, "cut.list").waitForExistence(timeout: 3))
        XCTAssertTrue(any(app, "cut.row.kim").exists)
        XCTAssertEqual(any(app, "cut.status").label, "Tap Draw a card")
        app.buttons["Ring"].tap()
        XCTAssertTrue(any(app, "cut.ring").waitForExistence(timeout: 3))
    }
}
