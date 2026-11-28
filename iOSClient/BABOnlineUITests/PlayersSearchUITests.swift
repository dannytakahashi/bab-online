import XCTest

/// The main room's Players sheet (owner 2026-11-27; fixture mode: UIFixture+PlayerSearch answers
/// searchPlayers, `-uiPlayerSearch` picks how): an empty field lists who is online; typing shows
/// matches with their avatar and an online dot, and a row opens that player's profile; nothing
/// found and offline are quiet lines. And the leaderboard: a tap on a row's avatar opens that
/// player's profile while a tap on the rest of the row still expands it. Runs on any device,
/// at any text size (`-UIPreferredContentSizeCategoryName`, or the `TEST_RUNNER_BAB_TYPE_SIZE`
/// environment, e.g. `UICTContentSizeCategoryAccessibilityXXXL`).
///
/// With `TEST_RUNNER_BAB_SHOTS=<folder>` (and `TEST_RUNNER_BAB_DEVICE=<tag>`) each `shot` is
/// also written there as a PNG.
final class PlayersSearchUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private var typeSize: [String] {
        ProcessInfo.processInfo.environment["BAB_TYPE_SIZE"].map { ["-UIPreferredContentSizeCategoryName", $0] } ?? []
    }

    private var env: [String: String] {
        ProcessInfo.processInfo.environment["BAB_AVATARS"].map { ["UI_FIXTURE_AVATARS": $0] } ?? [:]
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: screenshot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"] {
            let device = ProcessInfo.processInfo.environment["BAB_DEVICE"]
                ?? (UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone")
            let size = ProcessInfo.processInfo.environment["BAB_TYPE_SIZE"] == nil ? "" : "-ax"
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)\(size)-\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    /// The main room, then the Players sheet from "7 online" (the header's, or the vertical bar's).
    private func openPlayers(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra + typeSize, env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let online = app.buttons.matching(NSPredicate(format: "label == %@", "7 online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 5), "the online count")
        online.tap()
        XCTAssertTrue(app.navigationBars["Players"].waitForExistence(timeout: 5), "the Players sheet")
        return app
    }

    private func searchField(_ app: XCUIApplication) -> XCUIElement {
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the search field")
        return field
    }

    private func type(_ app: XCUIApplication, _ text: String) {
        let field = searchField(app)
        field.tap()
        field.typeText(text)
    }

    /// Clears the field (its clear button, else deleting what was typed).
    private func clear(_ app: XCUIApplication) {
        let field = searchField(app)
        let clearButton = field.buttons.firstMatch
        if clearButton.exists && clearButton.isHittable {
            clearButton.tap()
        } else {
            let value = field.value as? String ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
    }

    /// Brings `e` on screen in the sheet's list (large text pushes rows down).
    /// Scrolls the list down (never up: a pull at the top would close the sheet) until `e` is
    /// wholly on screen.
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement, in container: XCUIElement? = nil) {
        let list = container ?? element(app, "players.list")
        let window = app.windows.firstMatch.frame
        for _ in 0..<8 where !(e.exists && e.isHittable && window.contains(e.frame)) {
            list.swipeUp(velocity: .slow)
        }
    }

    func testAnEmptyFieldListsWhoIsOnline() {
        let app = openPlayers()
        XCTAssertEqual(searchField(app).placeholderValue, "Type a username...", "the web's prompt")
        let header = element(app, "players.onlineHeader")
        XCTAssertTrue(header.waitForExistence(timeout: 3))
        XCTAssertEqual(header.label, "Online now \u{00B7} 7")
        shot("players-empty")
        for name in ["kim", "hal", "jon", "ora", "max", "pat"] {
            let row = element(app, "online.\(name)")
            reveal(app, row)
            XCTAssertTrue(row.exists, name)
        }
        XCTAssertFalse(element(app, "online.ivy").exists, "my own row is just my name")
        XCTAssertTrue(app.staticTexts["ivy"].exists || app.descendants(matching: .any)["ivy, you, online"].exists, "my name is listed")
        // the last row (in view after the walk down the list)
        let pat = element(app, "online.pat")
        XCTAssertEqual(pat.label, "pat, online")
        reveal(app, pat)
        pat.tap()
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5), "an online row opens the profile")
        XCTAssertEqual(element(app, "profile.name").label, "pat")
        app.terminate()
    }

    func testTypingANameShowsResultsAndARowOpensTheProfile() {
        let app = openPlayers()
        type(app, "ki")
        let kim = element(app, "players.result.kim")
        XCTAssertTrue(kim.waitForExistence(timeout: 5), "results as you type")
        XCTAssertEqual(kim.label, "kim, online", "the online dot, spoken")
        XCTAssertEqual(element(app, "players.result.kimberly").label, "kimberly", "offline: no dot")
        XCTAssertTrue(element(app, "players.result.kip").exists)
        XCTAssertFalse(element(app, "players.result.ora").exists, "only matches")
        XCTAssertFalse(element(app, "players.onlineHeader").exists, "the online list gives way to the results")
        app.typeText("m")
        XCTAssertTrue(element(app, "players.result.kimberly").waitForExistence(timeout: 3))
        sleep(1)
        XCTAssertFalse(element(app, "players.result.kip").exists, "the latest query's results")
        shot("players-results")
        // the keyboard down, then the row
        if app.keyboards.firstMatch.exists { app.swipeDown(velocity: .slow) }
        reveal(app, kim)
        kim.tap()
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5), "a result opens the profile")
        XCTAssertEqual(element(app, "profile.name").label, "kim")
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 5))
        shot("players-profile")
        app.terminate()
    }

    func testNothingFoundThenClearedShowsTheOnlineListAgain() {
        let app = openPlayers()
        type(app, "zzz")
        let none = element(app, "players.noResults")
        XCTAssertTrue(none.waitForExistence(timeout: 5))
        XCTAssertEqual(none.label, "No players found")
        clear(app)
        XCTAssertTrue(element(app, "players.onlineHeader").waitForExistence(timeout: 3), "an empty field: the online list")
        XCTAssertFalse(none.exists)
        app.terminate()
    }

    func testMyOwnResultIsNotAButton() {
        let app = openPlayers()
        type(app, "ivy")
        let me = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "ivy, you, online")).firstMatch
        XCTAssertTrue(me.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "players.result.ivy").exists, "my profile lives in Account")
        app.terminate()
    }

    func testOfflineIsAQuietLine() {
        let app = openPlayers(["-uiPlayerSearch", "offline"])
        type(app, "kim")
        let line = element(app, "players.unavailable")
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertEqual(line.label, "Search is available once you're connected.")
        XCTAssertFalse(app.alerts.firstMatch.exists, "never an error alert")
        app.terminate()
    }

    func testASlowSearchShowsItIsWorking() {
        let app = openPlayers(["-uiPlayerSearch", "slow"])
        type(app, "kim")
        XCTAssertTrue(element(app, "players.searching").waitForExistence(timeout: 2), "a spinner once it waits")
        XCTAssertTrue(element(app, "players.result.kim").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "players.searching").exists)
        app.terminate()
    }

    // MARK: - Leaderboard avatars

    private func openLeaderboard() -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: typeSize, env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let trophy = StatsUITests.trophy(app)
        XCTAssertTrue(trophy.waitForExistence(timeout: 5))
        trophy.tap()
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 8), "the leaderboard's rows")
        return app
    }

    /// Each row's avatar target (in its row's points) from the fixture probe.
    private func avatarTargets(_ app: XCUIApplication) -> [String: CGRect] {
        let probe = element(app, "leaderboard.avatarTargets")
        guard probe.waitForExistence(timeout: 3), let value = probe.value as? String, !value.isEmpty else { return [:] }
        var out: [String: CGRect] = [:]
        for part in value.split(separator: ";") {
            guard let colon = part.lastIndex(of: ":") else { continue }
            let n = part[part.index(after: colon)...].split(separator: " ").compactMap { Double($0) }
            guard n.count == 4 else { continue }
            out[String(part[..<colon])] = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
        }
        return out
    }

    /// A tap at `point` in `element`'s own points.
    private func tap(_ element: XCUIElement, at point: CGPoint) {
        element.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()
    }

    func testTheLeaderboardAvatarOpensAProfileAndTheRowStillExpands() {
        let app = openLeaderboard()
        let row = element(app, "leaderboard.row.kim")
        let targets = avatarTargets(app)
        guard let kim = targets["kim"] else { return XCTFail("no avatar target for kim: \(targets)") }
        XCTAssertNil(targets["ivy"], "my own row offers no profile")
        XCTAssertNil(targets["Population"], "nor the population row")
        XCTAssertGreaterThanOrEqual(kim.width, 44, "a 44 pt target")
        XCTAssertGreaterThanOrEqual(kim.height, 44)
        let rowFrame = row.frame
        XCTAssertEqual(kim.height, rowFrame.height, accuracy: 1, "the row's full height")
        XCTAssertTrue(CGRect(origin: .zero, size: rowFrame.size).insetBy(dx: -1, dy: -1).contains(kim), "inside the row: \(kim) in \(rowFrame)")
        XCTAssertLessThan(kim.minX, rowFrame.width / 3, "over the avatar's column, near the leading edge")

        // the avatar: kim's profile
        tap(row, at: CGPoint(x: kim.midX, y: kim.midY))
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5), "the avatar opens the profile")
        XCTAssertEqual(element(app, "profile.name").label, "kim")
        XCTAssertFalse(element(app, "leaderboard.details.kim").exists, "the avatar tap did not expand the row")
        shot("leaderboard-avatar-profile")
        element(app, "profile.close").tap()
        XCTAssertFalse(element(app, "profile.name").waitForExistence(timeout: 2))

        // the rest of the row: expands as before (the list; the iPad's table has no expansion)
        let isTable = element(app, "leaderboard.sort.winRate").exists
        tap(row, at: CGPoint(x: rowFrame.width - 40, y: rowFrame.height / 2))
        if isTable {
            XCTAssertFalse(element(app, "profile.name").waitForExistence(timeout: 2), "the table row's body opens nothing")
        } else {
            XCTAssertTrue(element(app, "leaderboard.details.kim").waitForExistence(timeout: 3), "the row body still expands")
            XCTAssertFalse(element(app, "profile.name").exists)
            // and folds again from the same spot
            tap(row, at: CGPoint(x: rowFrame.width - 40, y: rowFrame.height / 2))
            sleep(1)
            XCTAssertFalse(element(app, "leaderboard.details.kim").exists, "folds again")
        }
        // a tap on my own row's avatar spot opens nothing
        let me = element(app, "leaderboard.row.ivy")
        reveal(app, me, in: element(app, "leaderboard.list"))
        tap(me, at: CGPoint(x: kim.midX, y: me.frame.height / 2))
        XCTAssertFalse(element(app, "profile.name").waitForExistence(timeout: 2), "no profile from my own row")
        app.terminate()
    }

    func testTheLeaderboardRowIsOneElementWithAViewProfileAction() {
        let app = openLeaderboard()
        let row = element(app, "leaderboard.row.kim")
        XCTAssertEqual(row.label, "Rank 2, kim", "one element, as before")
        // the clear target adds no element of its own: nothing but the row is named kim
        let named = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'kim'"))
            .allElementsBoundByIndex.filter { $0.exists && $0.identifier.hasPrefix("leaderboard") }
        XCTAssertEqual(Set(named.map(\.identifier)), ["leaderboard.row.kim"])
        app.terminate()
    }
}
