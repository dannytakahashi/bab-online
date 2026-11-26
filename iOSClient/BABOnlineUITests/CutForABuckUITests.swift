import XCTest

/// Cut for a buck on iOS 1.2.7 (41), fixture mode (`tournament-cut -uiCut "<n> <stage>"`,
/// UIFixture+Cut): every stage's screen, the ring's layout probe ("cut.layoutCheck") for 2 to 20
/// players, the deck's draw and the tap after the server drew for me (in "fixture.sent"), the flip
/// and verdict, an out player still watching, the winner, the final lobby, a spectator, the list
/// at the largest text size, the intro over the ring and over the list (and its Reduce Motion
/// form), and the score screen's strip.
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

    private func open(_ n: Int, _ stage: String, _ extra: [String] = [], env: [String: String] = [:]) -> XCUIApplication {
        let app = Fixture.launch("tournament-cut", extra: ["-uiCut", "\(n) \(stage)"] + extra, env: env)
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
            if Fixture.probe(app, "cut.ringFit").hasPrefix("list fits=no ") {
                // too many for this stage (avatars under 24 pt): the list, never a ring too small to read
                XCTAssertGreaterThanOrEqual(n, 13, "\(n) players should fit the ring")
                assertTheListStandsIn(app, n)
                if n == 20 { keep("ring-unfit-\(n)") }
                app.terminate()
                continue
            }
            XCTAssertTrue(Fixture.probe(app, "cut.ringFit").hasPrefix("ring fits=yes "))
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

    /// The list in the ring's place: the note, every player's row, Ring unavailable (dimmed for
    /// VoiceOver) and a tap on it changing nothing.
    private func assertTheListStandsIn(_ app: XCUIApplication, _ n: Int, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(any(app, "cut.list").waitForExistence(timeout: 5), "the list", file: file, line: line)
        XCTAssertFalse(any(app, "cut.ring").exists, "no ring", file: file, line: line)
        let note = any(app, "cut.listNote")
        XCTAssertTrue(note.exists, "the note", file: file, line: line)
        XCTAssertEqual(note.label, "Too many players to fit the ring on this screen.", file: file, line: line)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cut.row.'"))
        XCTAssertEqual(rows.count, n, "a row a player", file: file, line: line)
        let ring = app.buttons["Ring"]
        XCTAssertTrue(ring.exists, file: file, line: line)
        XCTAssertFalse(ring.isEnabled, "Ring is unavailable while the ring cannot fit", file: file, line: line)
        XCTAssertTrue(app.buttons["List"].isSelected, "List shows as chosen", file: file, line: line)
        ring.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(any(app, "cut.list").exists, "a tap on Ring keeps the list", file: file, line: line)
        XCTAssertTrue(Fixture.probe(app, "cut.ringFit").hasPrefix("list fits=no "), file: file, line: line)
    }

    /// Forty players (owner 2026-11-25, "auto-switch to list when it doesn't fit"): no device's
    /// stage holds them at 24 pt avatars but the iPad's landscape one, so the list shows with the note;
    /// my choice (Ring) is kept, the list is only what shows.
    func testManyPlayersGetTheListWithTheNote() {
        let app = open(40, "drawing", ["-uiCutView", "ring"])
        let fit = Fixture.probe(app, "cut.ringFit")
        if fit.hasPrefix("ring fits=yes ") {
            XCTAssertEqual(UIDevice.current.userInterfaceIdiom, .pad, "40 players fit only an iPad's stage: \(fit)")
            XCTAssertTrue(Fixture.probe(app, "cut.layoutCheck").hasPrefix("ok n=40 "))
        } else {
            XCTAssertTrue(fit.hasPrefix("list fits=no "), fit)
            assertTheListStandsIn(app, 40)
            // my own row and Draw a card are there; a tap on Draw a card sends a random card
            XCTAssertTrue(any(app, "cut.row.ivy").exists)
            XCTAssertTrue(app.buttons["cut.listDraw"].isHittable)
            app.buttons["cut.listDraw"].tap()
            waitFor(4, "the draw sent") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:3:null") }
            keep("list-40")
        }
    }

    /// The check runs again on every size change: a rotation that gives the stage room brings the
    /// ring back (the choice is Ring), one that takes it away shows the list. Phones are held in
    /// portrait (AppDelegate.mask), so this runs where the stage changes with the rotation: the iPad,
    /// with a player count whose ring fits one orientation's stage and not the other's
    /// (`TEST_RUNNER_BAB_CUT_ROTATE_N`, else 22: on the iPad Air 11 (stage 451 x 945 portrait, 649 x 585 landscape) the list in portrait, the ring in
    /// landscape).
    func testARotationRechecksTheRing() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            throw XCTSkip("phones stay in portrait: no rotation changes the stage")
        }
        let n = Int(ProcessInfo.processInfo.environment["BAB_CUT_ROTATE_N"] ?? "") ?? 22
        XCUIDevice.shared.orientation = .portrait
        let app = open(n, "drawing", ["-uiCutView", "ring"])
        defer { XCUIDevice.shared.orientation = .portrait }
        var seen: [String] = []
        var probes: [String] = []
        for o in [UIDeviceOrientation.portrait, .landscapeLeft, .portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = o
            sleep(2)
            let probe = Fixture.probe(app, "cut.ringFit")
            let fit = probe.components(separatedBy: " stage=").first ?? probe
            seen.append(fit)
            probes.append(probe)
            if fit == "ring fits=yes" {
                XCTAssertTrue(any(app, "cut.ring").exists, "\(o.rawValue): the ring")
                XCTAssertFalse(any(app, "cut.listNote").exists)
                XCTAssertTrue(app.buttons["Ring"].isEnabled)
                XCTAssertTrue(app.buttons["Ring"].isSelected)
                let check = Fixture.probe(app, "cut.layoutCheck")
                XCTAssertTrue(check.hasPrefix("ok n=\(n) "), check)
            } else {
                XCTAssertEqual(fit, "list fits=no", "\(o.rawValue) \(probe)")
                XCTAssertTrue(any(app, "cut.list").exists, "\(o.rawValue): the list")
                XCTAssertTrue(any(app, "cut.listNote").exists)
                XCTAssertFalse(app.buttons["Ring"].isEnabled)
            }
            keep("rotate-\(n)-\(o.rawValue)")
        }
        XCTAssertEqual(seen, ["list fits=no", "ring fits=yes", "list fits=no", "ring fits=yes"],
                       "list in portrait, the ring in landscape, back and forth: \(probes)")
    }

    /// The complete phase's header on one line: the back control reads "Main Room" whole and the
    /// title gives way (one line, shrunk, then cut), never "ana's / Tournament" over two lines.
    func testTheFinalLobbysHeaderTitleStaysOnOneLine() {
        for name in ["ana's Tournament", "Christopher Johnson1's Tournament"] {
            let app = open(8, "complete", env: ["UI_FIXTURE_TOURNAMENT_NAME": name])
            let back = app.buttons["Main Room"]
            let title = app.staticTexts["tournament.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 5), name)
            if !Fixture.usesVerticalBar(app) {
                XCTAssertTrue(back.exists, name)
                XCTAssertEqual(back.label, "Main Room")
                XCTAssertLessThanOrEqual(back.frame.maxX, title.frame.minX + 0.5, "\(name): Main Room clear of the title")
            }
            XCTAssertEqual(title.label, name, "VoiceOver reads the whole name")
            // one headline line (about 22 pt at the default size), not two
            XCTAssertLessThan(title.frame.height, 30, "\(name): \(title.frame)")
            assertInside(app, title, name)
            keep("final-header-\(name.count)")
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
        XCTAssertEqual(any(app, "cut.deck").label, "Deck", "out: the deck is no draw target")
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
        // the default on a compact width; a regular one (the iPad, the open Duo) keeps the ring
        let compact = (Fixture.windowSize(Fixture.probe(app, "ui.pose"))?.width ?? 0) < 600
        if !compact, !list.waitForExistence(timeout: 3) { app.buttons["List"].firstMatch.tap() }
        XCTAssertTrue(list.waitForExistence(timeout: 5), "the list at the accessibility sizes")
        let draw = app.buttons["cut.listDraw"]
        XCTAssertTrue(draw.waitForExistence(timeout: 5))
        let scroll = app.scrollViews.containing(.any, identifier: "cut.list").firstMatch
        for _ in 0..<6 where !draw.isHittable {
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            start.press(forDuration: 0.05, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)),
                        withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(draw.isHittable, "Draw a card reachable at AX5: \(draw.frame)")
        keep("list-ax5")
        draw.tap()
        waitFor(3, "the list's draw") { Fixture.probe(app, "fixture.sent").contains("cutForABuckDraw:3:null") }
    }

    /// The intro with 12 players: over the ring where it fits, else over the list (the iPhone Duo
    /// closed, iOS 1.2.7 (41)'s release run: the intro lived in the ring alone and never played there).
    func testTheIntroPlaysAndGoes() {
        // a held frame: the title is up mid-intro (the live one may be over before the lobby is found)
        var app = open(12, "gather", ["-uiCutView", "ring", "-uiCutIntroFrame", "1.4"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3))
        XCTAssertEqual(any(app, "cut.intro").label, "Cut for a buck!")
        let ring = measuredFit(app).hasPrefix("ring ")
        XCTAssertEqual(Fixture.probe(app, "cut.introCheck"), "playing over=\(ring ? "ring" : "list")")
        keep("intro-1.4")
        app.terminate()
        // played: it goes within its 2.6 s, the ring (or the list) stays (12 s of gather left)
        app = open(12, "gather", ["-uiCutView", "ring"])
        assertTheIntroRunsItsLength(app)
        XCTAssertTrue(any(app, ring ? "cut.seat.kim" : "cut.row.kim").exists)
        keep("gather")
        app.terminate()
        app = open(12, "gather", ["-uiCutView", "ring", "-uiReduceMotion", "YES", "-uiCutIntroFrame", "0.6"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3), "Reduce Motion keeps the title, faded")
        keep("intro-reduced")
    }

    /// The intro over the list (owner 2026-11-25, "the intro when the cut starts", whatever shows):
    /// 30 players fit no device's ring, so the list shows; the title and the deck's shuffle play over
    /// it, run their 2.6 s and go, and the rows are there, reachable, after.
    func testTheIntroPlaysOverTheList() {
        var app = open(30, "gather", ["-uiCutView", "ring", "-uiCutIntroFrame", "1.4"])
        let fit = measuredFit(app)
        XCTAssertTrue(fit.hasPrefix("list fits=no "), fit)
        XCTAssertTrue(any(app, "cut.list").waitForExistence(timeout: 3))
        let title = any(app, "cut.intro")
        XCTAssertTrue(title.waitForExistence(timeout: 3), "the title over the list")
        XCTAssertEqual(title.label, "Cut for a buck!")
        XCTAssertEqual(Fixture.probe(app, "cut.introCheck"), "playing over=list")
        assertInside(app, title, "the title")
        keep("intro-list-1.4")
        app.terminate()
        // played: the whole length, then the rows
        app = open(30, "gather", ["-uiCutView", "ring"])
        XCTAssertTrue(any(app, "cut.status").label.hasPrefix("Cut for a buck starts in"))
        assertTheIntroRunsItsLength(app)
        XCTAssertTrue(any(app, "cut.row.ivy").isHittable, "my row, uncovered")
        keep("gather-list")
        app.terminate()
        // Reduce Motion: the same over the list, a crossfade
        app = open(30, "gather", ["-uiCutView", "list", "-uiReduceMotion", "YES", "-uiCutIntroFrame", "0.6"])
        XCTAssertTrue(any(app, "cut.intro").waitForExistence(timeout: 3), "Reduce Motion keeps the title over the list")
        XCTAssertEqual(Fixture.probe(app, "cut.introCheck"), "playing over=list")
        keep("intro-list-reduced")
    }

    /// "cut.ringFit" once the stage is measured (before that: "ring fits=-").
    private func measuredFit(_ app: XCUIApplication) -> String {
        var fit = ""
        waitFor(5, "the stage measured") { fit = Fixture.probe(app, "cut.ringFit"); return !fit.contains("fits=-") }
        return fit
    }

    /// The intro (started as the screen came up) goes, having run its whole length (a stage view
    /// rebuilt as the lobby came up used to end it in its first frames, which its going alone cannot
    /// tell from a played intro).
    private func assertTheIntroRunsItsLength(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        waitFor(4, "the intro ends") { !any(app, "cut.intro").exists }
        var ran = ""
        waitFor(4, "the intro's probe") { ran = Fixture.probe(app, "cut.introCheck"); return ran.hasPrefix("ran ") }
        let length = Double(ran.dropFirst(4)) ?? 0  // CutIntro.duration is 2.6 s
        XCTAssertGreaterThanOrEqual(length, 2.6 - 0.1, "the intro was cut short: \(ran)", file: file, line: line)
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
