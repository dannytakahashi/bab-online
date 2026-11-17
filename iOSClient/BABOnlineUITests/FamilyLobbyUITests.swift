import XCTest

/// Family lobbies of up to 8 and spectator voice on screen (1.2.2, build 12). Fixtures:
/// `game-lobby-family` (7 members, me the host; `-uiHost kim`: someone else),
/// `game-lobby-family-full` (the table filled without me), `main-room-family` (the n/8 cards),
/// `spectator-mid-hand -uiSpectatorVoice listen|full`, `game-lobby -uiVoicePanel YES
/// -uiVoiceSwitch YES` (the in-game switch in the panel). The rules are FamilyLobbyTests.
final class FamilyLobbyUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ fixture: String, extra: [String] = [], env: [String: String] = [:]) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra, env: env)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) never came up")
        return app
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    /// Scrolls the lobby until `e` can be tapped (7 rows and the Voice section overflow a phone).
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
        for _ in 0..<8 where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
    }

    private func flip(_ toggle: XCUIElement) {
        // the switch itself, at the row's trailing end (the label's centre may not toggle it)
        if toggle.switches.firstMatch.exists { toggle.switches.firstMatch.tap() } else {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        }
    }

    // MARK: - The lobby

    func testSevenMemberLobbyRowsAndTheHostsSwitch() {
        let app = launch("game-lobby-family")
        let count = any(app, "lobby.count")
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        XCTAssertEqual(count.label, "7 of 8 players, 2 of 4 ready")
        // every member has a row (not the first 4), with Playing / Sitting out
        for name in ["ivy", "kim", "hal", "jon", "ora", "max", "🤖 Bot"] {
            XCTAssertTrue(app.staticTexts[name].exists, "\(name)'s row")
        }
        XCTAssertEqual(any(app, "lobby.status.kim").label, "Playing")
        XCTAssertEqual(any(app, "lobby.status.🤖 Bot").label, "Sitting out")
        XCTAssertFalse(any(app, "lobby.status.jon").exists, "jon may still take a seat")
        XCTAssertEqual(app.staticTexts.matching(identifier: "lobby.host").count, 1, "one (host)")
        XCTAssertFalse(app.staticTexts["Waiting for player..."].exists, "no empty seats with 7 members")
        XCTAssertFalse(app.buttons["Add Bot"].exists, "Add Bot stays below 4 members")
        keep("family-lobby-host")

        // the host's switch, on by default; off waits for the server's echo
        let toggle = app.switches["lobby.spectatorsCanTalk"]
        reveal(app, toggle)
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertTrue(any(app, "lobby.voiceHint").label.contains("can talk"))
        flip(toggle)
        XCTAssertTrue(Fixture.probe(app, "fixture.sent").contains("setSpectatorsCanTalk:false"), Fixture.probe(app, "fixture.sent"))
        let off = NSPredicate(format: "value == '0' AND isEnabled == true")
        expectation(for: off, evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(any(app, "lobby.voiceHint").label.contains("can only listen"))
        keep("family-lobby-switch-off")
        app.terminate()
    }

    // MARK: - The header's count (owner 2026-11-16, build 12 on an iPhone 17: "4/8 · Rea...")

    /// The count is never cut off or covered: a real lobby's title ("iosplay1's Game"), the mic
    /// button (`-uiVoice YES`) and Leave, at the default and the largest text size, on the
    /// device the suite runs on. The "lobby.headerCheck" probe compares each piece of the count
    /// (and a one-line title) with a hidden copy at its full width, and checks that nothing in
    /// the header overlaps or leaves it (LobbyHeaderProbe); the frames are checked here too.
    func testTheHeaderCountIsFullyVisibleWithTheMicAndALongTitle() {
        for (tag, size) in [("default", nil), ("ax5", "UICTContentSizeCategoryAccessibilityXXXL")] as [(String, String?)] {
            var extra = ["-uiVoice", "YES"]
            if let size { extra += ["-UIPreferredContentSizeCategoryName", size] }
            let app = launch("game-lobby-family", extra: extra, env: ["UI_FIXTURE_LOBBY_NAME": "iosplay1's Game"])
            XCTAssertTrue(app.staticTexts["iosplay1's Game"].exists, "\(tag): the title")
            let check = headerCheck(app)
            let pose = Fixture.probe(app, "ui.pose")
            XCTAssertTrue(check.hasSuffix(" ok"), "\(tag): \(check) (\(pose))")

            let count = any(app, "lobby.count")
            XCTAssertTrue(count.waitForExistence(timeout: 5))
            XCTAssertEqual(count.label, "7 of 8 players, 2 of 4 ready", "VoiceOver hears both counts in full")
            let window = app.windows.firstMatch.frame
            XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(count.frame), "\(tag): \(count.frame) leaves \(window)")
            let mic = any(app, "lobby.mic")
            XCTAssertTrue(mic.exists, "\(tag): the header's mic")
            XCTAssertFalse(count.frame.intersects(mic.frame), "\(tag): the count under the mic")
            let leave = app.buttons["Leave"]
            if leave.exists { XCTAssertFalse(count.frame.intersects(leave.frame), "\(tag): the count under Leave") }

            // which form: never wrapped at the default size (one row where it fits; the count
            // under the title on phones, the closed Duo and the iPad's 55% column), wrapped at
            // accessibility sizes on a phone
            let width = Fixture.windowSize(pose)?.width ?? 0
            if size == nil {
                XCTAssertFalse(check.hasPrefix("wrapped"), "\(tag) at \(width) pt: \(check)")
                if width < 500 { XCTAssertTrue(check.hasPrefix("stacked"), "\(tag) at \(width) pt: \(check)") }
            } else if width < 500 {
                XCTAssertTrue(check.hasPrefix("wrapped"), "\(tag) at \(width) pt: \(check)")
            }
            keep("family-lobby-header-\(tag)")
            app.terminate()
        }
    }

    /// Without the mic, and with the table full ("Ready 4/4"), the count still shows in full.
    func testTheHeaderCountIsFullyVisibleWithoutTheMic() {
        let app = launch("game-lobby-family-full", env: ["UI_FIXTURE_LOBBY_NAME": "iosplay1's Game"])
        let check = headerCheck(app)
        XCTAssertTrue(check.hasSuffix(" ok"), check)
        XCTAssertEqual(any(app, "lobby.count").label, "7 of 8 players, 4 of 4 ready")
        app.terminate()
    }

    /// The probe once the header has been laid out (the first pass may not have every frame).
    private func headerCheck(_ app: XCUIApplication) -> String {
        var value = Fixture.probe(app, "lobby.headerCheck")
        let deadline = Date().addingTimeInterval(5)
        while !value.hasSuffix(" ok") && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.3)
            value = Fixture.probe(app, "lobby.headerCheck")
        }
        return value
    }

    func testOthersSeeTheSettingReadOnly() {
        let app = launch("game-lobby-family", extra: ["-uiHost", "kim"])
        let line = any(app, "lobby.spectatorsCanTalk.readOnly")
        reveal(app, line)
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertEqual(line.label, "Spectators can talk: On")
        XCTAssertFalse(app.switches["lobby.spectatorsCanTalk"].exists, "only the host has the switch")
        app.terminate()
    }

    func testTheTableFilledWithoutMe() {
        let app = launch("game-lobby-family-full")
        XCTAssertEqual(any(app, "lobby.count").label, "7 of 8 players, 4 of 4 ready")
        XCTAssertEqual(any(app, "lobby.status.ivy").label, "Will watch")
        XCTAssertEqual(any(app, "lobby.status.max").label, "Will watch")
        XCTAssertEqual(any(app, "lobby.status.ora").label, "Playing")
        let ready = app.buttons["Table full \u{2014} you'll watch"]
        reveal(app, ready)
        XCTAssertTrue(ready.waitForExistence(timeout: 5))
        XCTAssertFalse(ready.isEnabled, "Ready would be refused: the table is full")
        XCTAssertFalse(app.buttons["Ready"].exists)
        keep("family-lobby-table-full")
        app.terminate()
    }

    func testMainRoomCardsCountEveryMember() {
        let app = launch("main-room-family")
        let six = any(app, "lobbyCard.l1")
        XCTAssertTrue(six.waitForExistence(timeout: 5))
        XCTAssertTrue(six.label.contains("6/8 players"), six.label)
        XCTAssertTrue(any(app, "lobbyCard.l2").label.contains("8/8 players"))
        // the full 8/8 still holds my seat as member 7: Rejoin; the capacity-4 one is Full
        XCTAssertEqual(app.buttons.matching(identifier: "lobby.rejoin").count, 1)
        XCTAssertEqual(app.buttons.matching(identifier: "lobby.join").count, 1)
        XCTAssertTrue(any(app, "lobbyCard.l3").label.contains("4/4 players"))
        XCTAssertTrue(app.staticTexts["Full"].exists)
        keep("family-main-room")
        app.terminate()
    }

    // MARK: - Spectator voice

    /// A main-room spectator joins voice listen-only: the pill's button reads "Tap to talk",
    /// is never disabled, and a long press opens the voice panel with a "Watching" section.
    func testListenOnlyButtonOpensThePanelByLongPress() {
        let app = launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "listen"])
        XCTAssertTrue(app.staticTexts["Spectating (listening only)"].waitForExistence(timeout: 5))
        let mic = app.buttons["Tap to talk"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        XCTAssertTrue(mic.isEnabled, "not .disabled: that would also kill the long press")
        XCTAssertTrue(mic.isHittable)
        keep("spectator-voice-listen-only")
        mic.press(forDuration: 1.0)
        XCTAssertTrue(app.navigationBars["Voice Chat"].waitForExistence(timeout: 5), "the long press opens the panel")
        XCTAssertTrue(any(app, "voice.panel.listenOnly").exists)
        XCTAssertTrue(app.staticTexts["Watching"].exists || app.staticTexts["WATCHING"].exists, "the watchers' section")
        XCTAssertTrue(app.staticTexts["(watching)"].exists)
        XCTAssertTrue(app.staticTexts["lou"].exists)
        XCTAssertTrue(app.staticTexts["ivy"].exists)
        keep("spectator-voice-panel")
        app.terminate()
    }

    /// A pure spectator in voice has one mic button, the pill's: the seat row is the watched
    /// seat's (`-uiVoice` would draw the seat-row button were the spectator check missing).
    /// The pill's button keeps the 44 pt target.
    func testASpectatorHasOnlyThePillsMicButton() {
        let app = launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "listen", "-uiVoice", "YES"])
        let mic = app.buttons["Tap to talk"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Mute microphone"].exists, "no seat-row button in the watched seat's row")
        XCTAssertFalse(app.buttons["Unmute microphone"].exists)
        XCTAssertGreaterThanOrEqual(mic.frame.width, 44 - 0.5, "\(mic.frame)")
        XCTAssertGreaterThanOrEqual(mic.frame.height, 44 - 0.5, "\(mic.frame)")
        app.terminate()
    }

    func testVoiceFullSaysSo() {
        let app = launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "full"])
        XCTAssertTrue(app.staticTexts["Spectating \u{2022} Voice is full (8 people)"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Tap to talk"].exists)
        app.terminate()
    }

    /// The in-game switch: in the voice panel for whoever voiceSettings.canChange names.
    func testInGameSwitchInThePanel() {
        let app = launch("game-lobby", extra: ["-uiVoicePanel", "YES", "-uiVoiceSwitch", "YES"])
        XCTAssertTrue(app.navigationBars["Voice Chat"].waitForExistence(timeout: 5))
        let toggle = app.switches["voice.spectatorsCanTalk"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "1")
        flip(toggle)
        XCTAssertTrue(Fixture.probe(app, "fixture.sent").contains("setSpectatorsCanTalk:false"))
        expectation(for: NSPredicate(format: "value == '0' AND isEnabled == true"), evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
        keep("voice-panel-switch")
        app.terminate()
    }
}
