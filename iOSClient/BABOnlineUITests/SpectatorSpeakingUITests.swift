import XCTest

/// A spectator talking lights the spectator badge (the eye): its green outline, the speaking dot
/// on that row of its list and the VoiceOver value ("zach is talking"), in fixture mode with
/// `-uiSpeakingSpectators <name>[,<name>]` (Debug/UIFixture+Watchers.swift; fixture mode never
/// starts voice). A seated player or I never light it. Probe `table.spectatorsSpeaking`
/// ("lit=<0|1> names=<a,b|-> unnamed=<n>", what the badge was handed). The plain spectator
/// table, a seat's table, the over-the-shoulder view's eye and its bidding spot.
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs (speaking-*.png).
final class SpectatorSpeakingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ fixture: String, _ extra: [String]) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        return app
    }

    private func badge(_ app: XCUIApplication) -> XCUIElement { app.buttons["table.spectators"] }

    private func value(_ e: XCUIElement) -> String { (e.value as? String) ?? "" }

    /// Waits until the probe reads `want` (the fixture's talkers land right after the seed).
    @discardableResult
    private func waitProbe(_ app: XCUIApplication, _ want: String, timeout: TimeInterval = 8,
                           file: StaticString = #filePath, line: UInt = #line) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var last = Fixture.probe(app, "table.spectatorsSpeaking")
        while last != want && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            last = Fixture.probe(app, "table.spectatorsSpeaking")
        }
        XCTAssertEqual(last, want, file: file, line: line)
        return last
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let tag = ProcessInfo.processInfo.environment["BAB_DEVICE"].map { "-\($0)" } ?? ""
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("speaking-\(name)\(tag).png"))
        }
    }

    func testATalkingSpectatorLightsTheEyeAndItsRow() {
        let app = launch("spectator-mid-hand", ["-uiWatchers", "0:2", "-uiSpeakingSpectators", "zach"])
        let eye = badge(app)
        XCTAssertTrue(eye.waitForExistence(timeout: 5))
        waitProbe(app, "lit=1 names=zach unnamed=0")
        XCTAssertEqual(eye.label, "2 people watching")
        XCTAssertEqual(value(eye), "zach is talking")
        XCTAssertGreaterThanOrEqual(eye.frame.width, 44, "the 44 pt target")
        XCTAssertGreaterThanOrEqual(eye.frame.height, 44, "the 44 pt target")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "spectator")
        eye.tap()
        let zach = app.staticTexts["zach"], yan = app.staticTexts["yan"]
        XCTAssertTrue(zach.waitForExistence(timeout: 5))
        XCTAssertEqual(value(zach), "Talking")
        XCTAssertEqual(value(yan), "", "yan is not talking")
        shot(app, "spectator-list")
        app.terminate()
    }

    func testSeatedPlayersAndINeverLightIt() {
        // I am zach (a spectator); ivy and kim hold seats: none of us is the eye's
        let app = launch("spectator-mid-hand", ["-uiWatchers", "0:2", "-uiSpectatorName", "zach",
                                                "-uiSpeakingSpectators", "zach,ivy,kim"])
        XCTAssertTrue(badge(app).waitForExistence(timeout: 5))
        waitProbe(app, "lit=0 names=- unnamed=0")
        XCTAssertEqual(value(badge(app)), "")
        badge(app).tap()
        XCTAssertTrue(app.staticTexts["zach (you)"].waitForExistence(timeout: 5))
        XCTAssertEqual(value(app.staticTexts["zach (you)"]), "")
        app.terminate()
    }

    func testManyTalkersAndTheStop() {
        let app = launch("spectator-mid-hand", ["-uiWatchers", "0:3", "-uiSpeakingSpectators", "zach,yan,xena",
                                                "-uiSpeakingStop", "6"])
        XCTAssertTrue(badge(app).waitForExistence(timeout: 5))
        waitProbe(app, "lit=1 names=zach,yan,xena unnamed=0")
        XCTAssertEqual(value(badge(app)), "3 spectators are talking")
        // they stop: the outline goes, VoiceOver's value is empty again
        waitProbe(app, "lit=0 names=- unnamed=0", timeout: 12)
        XCTAssertEqual(value(badge(app)), "")
        app.terminate()
    }

    func testAPlayerSeesASpectatorTalk() {
        // a seat's table (me ivy at seat 1): a talking watcher lights the eye by my seat's row
        let app = launch("trick-mid-lead3", ["-uiWatchers", "0:2", "-uiSpeakingSpectators", "yan,?"])
        XCTAssertTrue(badge(app).waitForExistence(timeout: 5))
        waitProbe(app, "lit=1 names=yan unnamed=1")
        XCTAssertEqual(value(badge(app)), "yan and a spectator are talking")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "seat")
        app.terminate()
    }

    func testTheWatchersEyeLightsOverTheShoulderAndWhileBidding() {
        let app = launch("spectator-mid-hand", ["-uiShoulder", "auto", "-uiSpectatorVoice", "muted",
                                                "-uiWatchers", "0:2", "-uiSpeakingSpectators", "zach,yan"])
        XCTAssertTrue(app.buttons["shoulder.pill"].waitForExistence(timeout: 8))
        XCTAssertTrue(badge(app).waitForExistence(timeout: 5))
        waitProbe(app, "lit=1 names=zach,yan unnamed=0")
        XCTAssertEqual(value(badge(app)), "zach and yan are talking")
        XCTAssertFalse(value(app.buttons["shoulder.pill"]).contains("Talking"), "the watched player is not talking")
        shot(app, "shoulder")
        app.terminate()

        let bidding = launch("bidding-mid", ["-uiAsSpectator", "YES", "-uiShoulder", "4", "-uiSpectatorVoice", "muted",
                                             "-uiWatchers", "0:1", "-uiSpeakingSpectators", "zach"])
        XCTAssertTrue(bidding.descendants(matching: .any)["bidOverlay.watched"].waitForExistence(timeout: 8))
        XCTAssertTrue(badge(bidding).waitForExistence(timeout: 5))
        waitProbe(bidding, "lit=1 names=zach unnamed=0")
        XCTAssertEqual(value(badge(bidding)), "zach is talking")
        shot(bidding, "shoulder-bidding")
        bidding.terminate()
    }
}
