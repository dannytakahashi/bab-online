import XCTest

/// The main room's and the lobbies' header controls. Where the system shows the
/// vertical bar (the Duo closed, open in landscape, book pose) they are toolbar
/// items in that column ("vbar <edge>" in "ui.pose") and no content control
/// reaches into it; elsewhere they are the header row. Either way each control
/// exists exactly once and works.
final class LobbyControlsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// The vertical bar's column in screen points, nil where the system shows none.
    private func verticalBarColumn(_ app: XCUIApplication) -> ClosedRange<CGFloat>? {
        let pose = Fixture.probe(app, "ui.pose")
        // the Duo's poses with a vertical bar (TEST_RUNNER_BAB_POSE, as FixtureScreenshotTests)
        if let expected = ProcessInfo.processInfo.environment["BAB_POSE"], ["closed", "open-landscape"].contains(expected) {
            XCTAssertFalse(pose.hasSuffix("vbar -"), "no vertical bar reported in \(expected): \(pose)")
        }
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { return nil }
        switch edge {
        case "trailing": return (size.width - insets.right)...size.width
        case "leading": return 0...insets.left
        default:
            XCTFail("unexpected vertical bar edge in \(pose)")
            return nil
        }
    }

    private func buttons(_ app: XCUIApplication, _ predicate: String, _ arg: String) -> [XCUIElement] {
        app.buttons.matching(NSPredicate(format: predicate, arg)).allElementsBoundByIndex
    }

    /// Exactly one button with this label; in the column where there is a vertical bar.
    @discardableResult
    private func assertControl(_ app: XCUIApplication, _ predicate: String, _ arg: String,
                               column: ClosedRange<CGFloat>?, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement? {
        let found = buttons(app, predicate, arg)
        XCTAssertEqual(found.count, 1, "\(arg): \(found.map(\.label))", file: file, line: line)
        guard let e = found.first else { return nil }
        XCTAssertTrue(e.isHittable, "\(arg) is not hittable", file: file, line: line)
        if let column {
            XCTAssertTrue(column.contains(e.frame.midX), "\(arg) at \(e.frame) is not in the vertical bar \(column)", file: file, line: line)
        }
        return e
    }

    /// With a vertical bar no other button reaches into its column.
    private func assertContentClear(_ app: XCUIApplication, column: ClosedRange<CGFloat>?, barLabels: [String],
                                    file: StaticString = #filePath, line: UInt = #line) {
        guard let column else { return }
        for e in app.buttons.allElementsBoundByIndex where e.exists && !e.frame.isEmpty {
            if barLabels.contains(where: { e.label.contains($0) }) { continue }
            let f = e.frame
            let overlaps = f.maxX > column.lowerBound + 1 && f.minX < column.upperBound - 1
            XCTAssertFalse(overlaps, "\(e.label) at \(f) reaches into the vertical bar \(column)", file: file, line: line)
        }
    }

    func testMainRoomControls() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        sleep(1)
        let column = verticalBarColumn(app)
        let labels = ["New Game", "Tournament", "Stats", "7 online", "Account settings"]
        for label in labels {
            assertControl(app, "label == %@", label, column: column)
        }
        assertContentClear(app, column: column, barLabels: labels)

        buttons(app, "label == %@", "Stats").first?.tap()
        XCTAssertTrue(app.navigationBars["Stats"].waitForExistence(timeout: 5), "Stats opens the Stats sheet")
        app.terminate()
    }

    func testGameLobbyLeave() {
        lobbyLeave("game-lobby")
    }

    func testTournamentLobbyLeave() {
        lobbyLeave("tournament-lobby")
    }

    /// Regular width (the iPad, the open Duo): the lobby chat is the right-hand
    /// column, its field right of the player list; compact: under the players.
    func testGameLobbyChatPlacement() {
        chatPlacement("game-lobby", players: "lobby.players", field: "lobbyChatField")
    }

    /// Compact: the chat is pinned under the players, which scroll above it when
    /// they are taller than their share (their frame then runs on under the chat).
    func testTournamentLobbyChatPlacement() {
        chatPlacement("tournament-lobby", players: "tournament.players", field: "tournamentChatField", playersScroll: true)
        chatPlacement("tournament-round", players: "tournament.players", field: "tournamentChatField", playersScroll: true)
    }

    /// On regular width a second launch with a synthetic book fold (`-uiFold book`,
    /// 20 pt at the window center) checks that neither column spans the hinge.
    private func chatPlacement(_ fixture: String, players playersId: String, field fieldId: String, playersScroll: Bool = false) {
        if chatPlacement(fixture, players: playersId, field: fieldId, playersScroll: playersScroll, book: false) {
            _ = chatPlacement(fixture, players: playersId, field: fieldId, playersScroll: playersScroll, book: true)
        }
    }

    /// Returns whether the window reports regular width.
    private func chatPlacement(_ fixture: String, players playersId: String, field fieldId: String,
                               playersScroll: Bool, book: Bool) -> Bool {
        let app = Fixture.launch(fixture, extra: book ? ["-uiFold", "book"] : [])
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")
        let players = app.descendants(matching: .any)[playersId]
        let field = app.textFields[fieldId]
        XCTAssertTrue(players.waitForExistence(timeout: 5), "\(fixture): no \(playersId)")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "\(fixture): no \(fieldId)")
        let p = players.frame, f = field.frame
        let wide = pose.contains(" sc regular/")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertTrue(wide, "the iPad reports regular width: \(pose)")
        }
        if wide {
            XCTAssertGreaterThanOrEqual(f.minX, p.maxX - 1, "\(fixture) \(pose): the chat field \(f) is not right of the players \(p)")
            if let size = Fixture.windowSize(pose) {
                XCTAssertLessThanOrEqual(f.maxX, size.width + 1, "\(fixture): the chat field \(f) leaves the window \(size)")
                if book {
                    let hinge = (size.width / 2 - 10)...(size.width / 2 + 10)
                    XCTAssertLessThanOrEqual(p.maxX, hinge.lowerBound + 1, "\(fixture) book: the players \(p) span the hinge \(hinge)")
                    XCTAssertGreaterThanOrEqual(f.minX, hinge.upperBound - 1, "\(fixture) book: the chat field \(f) starts in the hinge \(hinge)")
                }
            }
        } else if playersScroll && p.maxY > f.minY + 1 {
            // the players scroll in their capped section: they start above the
            // chat and run on under it, clipped, never over the field
            XCTAssertLessThan(p.minY, f.minY - 40, "\(fixture) \(pose): the chat field \(f) is not under the players \(p)")
            XCTAssertTrue(field.isHittable, "\(fixture) \(pose): the players \(p) cover the chat field \(f)")
        } else {
            XCTAssertGreaterThanOrEqual(f.minY, p.maxY - 1, "\(fixture) \(pose): the chat field \(f) is not under the players \(p)")
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(Fixture.poseName(pose))-\(fixture)-chat-placement\(book ? "-book" : "")"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
        return wide
    }

    /// Compact (phones, the closed Duo): the chat is pinned under the players, so
    /// with 8 players and the standings (`tournament-round`) its field is inside
    /// the window and hittable without scrolling; after typing it stays hittable,
    /// above the software keyboard when one shows (none where the simulator has
    /// a hardware keyboard attached), and keeps the draft. Regular width too.
    ///
    /// The keyboard-overlap check (the compact layout's keyboard padding) only
    /// runs where a software keyboard shows in the window: neither UI-plan
    /// destination does (the closed Duo has a hardware keyboard attached, its
    /// software keyboard parked below the window; the iPad is wide), so
    /// the verification recipe adds an iPhone 17 run of this one test
    /// (docs/ios-table-store.md, lobby section). Elsewhere the skip is recorded
    /// as an activity in the result bundle.
    func testTournamentChatFieldOnScreen() {
        let fixture = "tournament-round"
        let app = Fixture.launch(fixture)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")
        guard let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else {
            return XCTFail("no window size in \(pose)")
        }
        let window = CGRect(origin: .zero, size: size)
        let visible = CGRect(x: insets.left, y: insets.top, width: size.width - insets.left - insets.right,
                             height: size.height - insets.top - insets.bottom)
        let field = app.textFields["tournamentChatField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no tournamentChatField")
        let f = field.frame
        XCTAssertTrue(window.contains(f), "\(pose): the chat field \(f) is not inside the window \(window)")
        XCTAssertTrue(visible.insetBy(dx: -1, dy: -1).contains(f), "\(pose): the chat field \(f) leaves the safe area \(visible)")
        XCTAssertTrue(field.isHittable, "\(pose): the chat field \(f) is not hittable")
        // the players are still there above it (compact) or beside it (wide)
        XCTAssertTrue(app.descendants(matching: .any)["tournament.players"].exists)

        field.tap()
        field.typeText("gl all")
        let kb = app.keyboards.firstMatch
        let typed = app.textFields["tournamentChatField"]
        // On an iPad 13 sim the lobby moves the field above the keyboard 2-5 s after typing
        // (measured the same on 6aab8f5), so wait for it to settle instead of a fixed 1 s.
        let settle = Date().addingTimeInterval(8)
        sleep(1)
        while Date() < settle {
            let up = kb.exists && !kb.frame.isEmpty && kb.frame.minY < window.maxY - 1
            if typed.isHittable && (!up || typed.frame.maxY <= kb.frame.minY + 1) { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        let t = typed.frame
        XCTAssertTrue(typed.isHittable, "\(pose): with the keyboard up the chat field \(t) is not hittable")
        XCTAssertTrue(window.contains(t), "\(pose): with the keyboard up the chat field \(t) leaves the window")
        // with a hardware keyboard attached the software one still exists, parked
        // below the window (closed Duo: y 722 in a 678 pt window), so only a
        // keyboard that reaches into the window counts as showing
        if kb.exists && !kb.frame.isEmpty && kb.frame.minY < window.maxY - 1 {
            XCTAssertLessThanOrEqual(t.maxY, kb.frame.minY + 1, "\(pose): the keyboard \(kb.frame) covers the chat field \(t)")
        } else {
            XCTContext.runActivity(named: "\(pose): no software keyboard, keyboard-overlap check skipped (run on an iPhone)") { _ in }
        }
        XCTAssertEqual(typed.value as? String, "gl all", "the draft")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(Fixture.poseName(pose))-\(fixture)-chat-keyboard"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
    }

    private func lobbyLeave(_ fixture: String) {
        let app = Fixture.launch(fixture)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let column = verticalBarColumn(app)
        assertControl(app, "label CONTAINS %@", "Leave", column: column)
        assertContentClear(app, column: column, barLabels: ["Leave"])
        app.terminate()
    }
}
