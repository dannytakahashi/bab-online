import XCTest

/// Item 26: launches each fixture and saves an XCUIScreen screenshot of every
/// display as a kept attachment named `<pose>-<fixture>-screen<i>-<WxH>`
/// (export with iOSClient/scripts/ios-screenshots.sh). The pose comes from the
/// app's "ui.pose" probe: 466x678 closed, 669x951 open-portrait, 951x669
/// open-landscape (the Duo's pose is set by hand in Device Hub; with
/// TEST_RUNNER_BAB_POSE=<name> the run asserts it). In open-portrait each
/// table fixture is also shot in landscape.
final class FixtureScreenshotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private func shoot(_ app: XCUIApplication, _ fixture: String, suffix: String = "") -> String {
        let pose = Fixture.probe(app, "ui.pose")
        let name = Fixture.poseName(pose)
        for (i, screen) in XCUIScreen.screens.enumerated() {
            if name == "closed" && i == 1 { continue }  // the folded inner display is black
            let shot = screen.screenshot()
            let w = Int(shot.image.size.width * shot.image.scale), h = Int(shot.image.size.height * shot.image.scale)
            let a = XCTAttachment(screenshot: shot)
            a.name = "\(name)\(suffix)-\(fixture)-screen\(i)-\(w)x\(h)"
            a.lifetime = .keepAlways
            add(a)
        }
        let p = XCTAttachment(string: "\(pose)\nlayoutCheck: \(Fixture.probe(app, "table.layoutCheck"))\nstate: \(Fixture.probe(app, "table.state"))")
        p.name = "\(name)\(suffix)-\(fixture)-probes"
        p.lifetime = .keepAlways
        add(p)
        return name
    }

    private func run(_ fixture: String, extra: [String] = [], suffix: String = "") {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) did not come up")
        sleep(1)
        let isTable = Fixture.tableFixtures.contains(fixture)
        if isTable { _ = Fixture.settledState(app) }
        let pose = shoot(app, fixture, suffix: suffix)
        if let expected = ProcessInfo.processInfo.environment["BAB_POSE"], suffix.isEmpty {
            XCTAssertEqual(pose, expected, "the simulator is not in the expected pose")
        }
        if isTable {
            XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", "\(fixture) \(pose)")
        }
        // the open inner display also runs in landscape
        if pose == "open-portrait" && suffix.isEmpty {
            let before = isTable ? Fixture.settledState(app) : ""
            XCUIDevice.shared.orientation = .landscapeLeft
            sleep(2)
            _ = shoot(app, fixture, suffix: "-rotated")
            if isTable {
                XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", "\(fixture) landscape")
                XCTAssertEqual(Fixture.settledState(app), before, "\(fixture): rotation kept the table state")
            }
            XCUIDevice.shared.orientation = .portrait
            sleep(1)
        }
        app.terminate()
    }

    func testTrickMidLead3() { run("trick-mid-lead3") }
    func testBiddingMid() { run("bidding-mid") }
    func testBetweenTricks() { run("between-tricks") }
    func testSpectatorMidHand() { run("spectator-mid-hand") }
    func testLazyAtSeat() { run("lazy-at-seat") }
    func testPresenceMixed() { run("presence-mixed") }
    func testTournamentGame() { run("tournament-game") }
    func testGameEnd() { run("game-end") }
    func testDrawInProgress() { run("draw-in-progress") }
    func testMainRoom() { run("main-room") }
    func testGameLobby() { run("game-lobby") }
    func testTournamentLobby() { run("tournament-lobby") }
    func testTournamentRound() { run("tournament-round") }
    func testTournamentBetween() { run("tournament-between") }
    func testSignIn() { run("sign-in") }

    /// Synthetic fold regions (`-uiFold`): the docked book layout and the tabletop split.
    func testFoldBook() {
        run("trick-mid-lead3", extra: ["-uiFold", "book"], suffix: "-book")
        run("bidding-mid", extra: ["-uiFold", "book"], suffix: "-book")
    }

    func testFoldTabletop() {
        run("trick-mid-lead3", extra: ["-uiFold", "tabletop"], suffix: "-tabletop")
        run("bidding-mid", extra: ["-uiFold", "tabletop"], suffix: "-tabletop")
    }

    /// A snapshot from the test bundle through the environment (any snapshot, e.g. a log checkpoint).
    func testSnapshotThroughEnvironment() throws {
        final class Token {}
        let url = try XCTUnwrap(Bundle(for: Token.self).url(forResource: "spectator-mid-hand", withExtension: "json", subdirectory: "v2"))
        let raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let snap = try JSONSerialization.data(withJSONObject: try XCTUnwrap(raw["snapshot"]))
        let app = Fixture.launch("env", env: ["UI_FIXTURE_SNAPSHOT": String(decoding: snap, as: UTF8.self)])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Exit"].firstMatch.exists, "the spectator pill")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()
    }

    /// Typing in the game log must not move the table (it ignores the keyboard).
    func testKeyboardLeavesTheTableAlone() {
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let pose = Fixture.probe(app, "ui.pose")
        let state = Fixture.settledState(app)
        // the log is a drawer, except where it is docked open (open-Duo landscape, book pose)
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("hello table")
        sleep(1)
        XCTAssertEqual(Fixture.probe(app, "ui.pose"), pose, "the keyboard changed the table's insets")
        XCTAssertEqual(Fixture.settledState(app), state)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()
    }
}
