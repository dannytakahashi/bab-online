import XCTest

/// Profiles in fixture mode (iOS 1.2.2; the replies come from UIFixture+Profile, `-uiProfile`
/// picks them): my own profile in the Account sheet (picture, the twelve stats, the scope),
/// Choose Avatar and Upload Photo with their confirmations and errors, and another player's
/// profile sheet (stats, Report, Block / Unblock) opened from a chat line's long-press menu,
/// the online list and a seat's avatar at the table. Runs on any device.
///
/// With `TEST_RUNNER_BAB_SHOTS=<folder>` every `shot` is also written there as a PNG, and with
/// `TEST_RUNNER_BAB_AVATARS=<repo>/client/assets` the stock avatars show their art.
final class ProfileUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
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
            let idiom = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(idiom)-\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func stat(_ app: XCUIApplication, _ id: String) -> String {
        let e = element(app, "profile.stat.\(id)")
        return e.exists ? (e.value as? String ?? "<nil>") : "<none>"
    }

    private func waitForStat(_ app: XCUIApplication, _ id: String, _ value: String, timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if stat(app, id) == value { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func openAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra, env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let gear = app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        gear.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5), "the Account sheet")
        return app
    }

    /// Brings `e` on screen in the sheet's list.
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
        for _ in 0..<6 where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
    }

    private func waitForSent(_ app: XCUIApplication, containing text: String, timeout: TimeInterval = 5) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var sent = Fixture.probe(app, "fixture.sent")
        while !sent.contains(text) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            sent = Fixture.probe(app, "fixture.sent")
        }
        return sent
    }

    // MARK: - My own profile

    /// The Account sheet opens on my picture and name, then the web's twelve stats for human
    /// games; Bots has none yet (the note), All sums both; the choice is the Stats sheet's.
    func testOwnProfileShowsPictureStatsAndScope() {
        let app = openAccount()
        let hero = element(app, "profile.hero")
        XCTAssertTrue(hero.waitForExistence(timeout: 5))
        XCTAssertTrue(hero.label.contains("Signed in as"), hero.label)
        XCTAssertTrue(hero.label.contains("ivy"), hero.label)
        XCTAssertTrue(element(app, "profile.uploadPhoto").exists)
        XCTAssertTrue(element(app, "profile.chooseAvatar").exists)

        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"), "my human games: \(stat(app, "gamesPlayed"))")
        let expected = ["gamesPlayed": "51", "wins": "30", "losses": "21", "winRate": "58.8%", "pointsPerGame": "231.0",
                        "bidsPerGame": "12.5", "tricksPerGame": "12.7", "tricksPerBid": "1.02", "setRate": "11.5%",
                        "drag": "60.0", "faultsPerGame": "0.20", "hsi": "8.1"]
        shot("account-profile")
        let scope = app.segmentedControls["profile.scope"]
        reveal(app, scope)
        XCTAssertEqual(scope.buttons.count, 3)
        XCTAssertTrue(scope.buttons["Human games"].isSelected, "Humans by default")
        reveal(app, element(app, "profile.stat.hsi"))
        for (id, value) in expected {
            XCTAssertEqual(stat(app, id), value, id)
        }
        shot("account-profile-stats")

        scope.buttons["Bot games"].tap()
        XCTAssertTrue(element(app, "profile.botsEmpty").waitForExistence(timeout: 5), "no bot games: the note")
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "0"))
        XCTAssertEqual(stat(app, "winRate"), "0%")
        shot("account-profile-bots-empty")
        scope.buttons["All games"].tap()
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        XCTAssertFalse(element(app, "profile.botsEmpty").exists)

        // one choice with the Stats sheet
        app.buttons["Done"].firstMatch.tap()
        StatsUITests.trophy(app).tap()
        XCTAssertTrue(app.segmentedControls["stats.scope"].buttons["All games"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.segmentedControls["stats.scope"].buttons["All games"].isSelected)
        app.terminate()
    }

    /// Choose Avatar: the 82 stock pictures; a tap sends it, closes the picker and confirms.
    func testChooseAvatar() {
        let app = openAccount()
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        element(app, "profile.chooseAvatar").tap()
        XCTAssertTrue(app.navigationBars["Select Profile Picture"].waitForExistence(timeout: 5))
        // the current picture (31) is marked and scrolled to
        let current = element(app, "avatarPicker.31")
        XCTAssertTrue(current.waitForExistence(timeout: 5))
        XCTAssertTrue(current.isSelected, "my picture is marked")
        XCTAssertEqual(current.label, "Avatar 31")
        shot("avatar-picker")
        let pick = element(app, "avatarPicker.33")
        XCTAssertTrue(pick.waitForExistence(timeout: 3))
        pick.tap()
        let notice = element(app, "profile.pictureNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "the confirmation in the Account sheet")
        XCTAssertEqual(notice.label, "Profile picture updated!")
        XCTAssertTrue(waitForSent(app, containing: "updateProfilePic:33").contains("updateProfilePic:33"))
        shot("avatar-updated")
        element(app, "profile.chooseAvatar").tap()
        XCTAssertTrue(element(app, "avatarPicker.33").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "avatarPicker.33").isSelected, "the new picture is the marked one")
        XCTAssertFalse(element(app, "avatarPicker.31").isSelected)
        element(app, "avatarPicker.close").tap()
        app.terminate()
    }

    /// The picture rows work with the hero row scrolled out of the list (the picker sheet and
    /// the upload hang on the List, not on a row that is torn down off screen): at the largest
    /// text size the hero leaves the screen while Choose Avatar is still on it.
    func testChooseAvatarWithTheHeroScrolledAway() {
        let app = openAccount(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        let hero = element(app, "profile.hero"), choose = element(app, "profile.chooseAvatar")
        let bar = app.navigationBars["Account"]
        let window = app.windows.firstMatch
        func heroGone() -> Bool { !hero.exists || hero.frame.maxY <= bar.frame.maxY + 1 }
        // short drags that end at rest, so the list stops where the hero has just left
        for _ in 0..<30 where !heroGone() {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
                .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.56)),
                       withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(heroGone(), "the hero row is off screen")
        XCTAssertTrue(choose.exists && choose.isHittable, "Choose Avatar is still on screen")
        XCTAssertGreaterThan(choose.frame.midY, bar.frame.maxY, "and below the bar")
        shot("account-hero-scrolled-away")
        choose.tap()
        XCTAssertTrue(app.navigationBars["Select Profile Picture"].waitForExistence(timeout: 5), "the picker opens without the hero row")
        let pick = element(app, "avatarPicker.33")
        XCTAssertTrue(pick.waitForExistence(timeout: 5))
        pick.tap()
        XCTAssertTrue(waitForSent(app, containing: "updateProfilePic:33").contains("updateProfilePic:33"))
        let notice = element(app, "profile.pictureNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertEqual(notice.label, "Profile picture updated!")
        app.terminate()
    }

    /// Upload Photo through the real system picker (the simulator's stock photo library): the
    /// first photo goes through the load, the crop and the send. Skipped where the picker's
    /// grid cannot be reached by the test.
    func testUploadPhotoWithTheSystemPicker() throws {
        let app = openAccount()
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        element(app, "profile.uploadPhoto").tap()
        // a grid cell (the banner's app icon is an image too, and small)
        var cell: XCUIElement?
        let deadline = Date().addingTimeInterval(15)
        while cell == nil && Date() < deadline {
            cell = app.images.allElementsBoundByIndex.first { $0.frame.width > 100 && $0.isHittable }
            if cell == nil { Thread.sleep(forTimeInterval: 0.5) }
        }
        guard let photo = cell else {
            throw XCTSkip("the system photo picker's grid is not reachable here")
        }
        shot("system-picker")
        photo.tap()
        let notice = element(app, "profile.pictureNotice")
        if !notice.waitForExistence(timeout: 15) { shot("system-picker-after-tap") }
        XCTAssertTrue(notice.exists, "the picked photo was loaded, cropped and sent")
        XCTAssertEqual(notice.label, "Profile picture uploaded!")
        let sent = waitForSent(app, containing: "uploadProfilePic:png:")
        let length = sent.components(separatedBy: "uploadProfilePic:png:").last.flatMap { Int($0.split(separator: "|").first ?? "") } ?? -1
        XCTAssertGreaterThan(length, 1000, sent)
        XCTAssertLessThanOrEqual(length, 682_666)
        shot("photo-uploaded-system-picker")
        app.terminate()
    }

    /// Upload Photo: the picked photo goes out as a PNG data URL within the server's limit and
    /// the confirmation shows (the fixture's sample replaces the system picker).
    func testUploadPhoto() {
        let app = openAccount(["-uiPickPhoto", "YES"])
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        element(app, "profile.uploadPhoto").tap()
        let notice = element(app, "profile.pictureNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 6))
        XCTAssertEqual(notice.label, "Profile picture uploaded!")
        let sent = waitForSent(app, containing: "uploadProfilePic:png:")
        let length = sent.components(separatedBy: "uploadProfilePic:png:").last.flatMap { Int($0.split(separator: "|").first ?? "") } ?? -1
        XCTAssertGreaterThan(length, 1000, sent)
        XCTAssertLessThanOrEqual(length, 682_666, "within uploadProfilePic's limit")
        shot("photo-uploaded")
        // a custom picture: no stock avatar is marked
        element(app, "profile.chooseAvatar").tap()
        XCTAssertTrue(element(app, "avatarPicker.1").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "avatarPicker.1").isSelected)
        app.terminate()
    }

    /// The server's refusals show in the sheet: the stats' failure with a retry, the picture
    /// change's message in red.
    func testErrorsShow() {
        let app = openAccount(["-uiProfile", "error", "-uiPickPhoto", "YES"])
        let failed = element(app, "profile.statsError")
        XCTAssertTrue(failed.waitForExistence(timeout: 6), "the stats request failed")
        XCTAssertTrue(app.staticTexts["Couldn't load statistics: Database error"].exists)
        XCTAssertTrue(app.buttons["Try Again"].exists)
        shot("account-profile-error")
        element(app, "profile.uploadPhoto").tap()
        let notice = element(app, "profile.pictureNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 6))
        XCTAssertEqual(notice.label, "Could not read that image. Please try a PNG, JPEG, GIF or WebP.")
        element(app, "profile.chooseAvatar").tap()
        element(app, "avatarPicker.2").tap()
        XCTAssertTrue(waitForLabel(notice, "Database error"), notice.label)
        app.terminate()
    }

    private func waitForLabel(_ e: XCUIElement, _ label: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if e.exists && e.label == label { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    /// The largest text size: two columns, every stat still there and on screen after a scroll.
    func testOwnProfileAtTheLargestTextSize() {
        let app = openAccount(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "51"))
        let games = element(app, "profile.stat.gamesPlayed"), wins = element(app, "profile.stat.wins"), losses = element(app, "profile.stat.losses")
        reveal(app, losses)
        XCTAssertEqual(games.frame.midY, wins.frame.midY, accuracy: 2, "two cells side by side")
        XCTAssertLessThan(games.frame.maxX, wins.frame.minX + 1)
        XCTAssertGreaterThan(losses.frame.minY, games.frame.maxY - 1, "the third starts the next row")
        shot("account-profile-ax5")
        reveal(app, element(app, "profile.stat.hsi"))
        XCTAssertEqual(stat(app, "hsi"), "8.1")
        app.terminate()
    }

    // MARK: - Another player's profile

    private func openProfileFromChat(_ app: XCUIApplication, line: String) {
        let text = app.staticTexts[line].firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 5), "chat line \(line)")
        text.press(forDuration: 1.2)
        let view = app.buttons["View Profile"].firstMatch
        XCTAssertTrue(view.waitForExistence(timeout: 5), "the long-press menu has View Profile")
        XCTAssertTrue(app.buttons["Report User"].exists)
        XCTAssertTrue(app.buttons["Block User"].exists)
        view.tap()
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5), "the profile sheet")
    }

    /// A chat line's long-press menu opens the player's profile: name, stats by scope, Report
    /// (the reason prompt), Block (a confirmation) and Unblock (none, as on the web).
    func testPlayerProfileFromChatReportAndBlock() {
        let app = Fixture.launch("main-room", env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        openProfileFromChat(app, line: "rematch?")
        XCTAssertEqual(element(app, "profile.name").label, "kim")
        XCTAssertTrue(app.navigationBars["kim"].exists)
        XCTAssertTrue(element(app, "profile.stat.gamesPlayed").waitForExistence(timeout: 6), "kim's stats")
        let humanGames = stat(app, "gamesPlayed")
        XCTAssertNotEqual(humanGames, "0")
        shot("player-profile")
        app.segmentedControls["profile.scope"].buttons["Bot games"].tap()
        XCTAssertTrue(waitForStat(app, "gamesPlayed", "4"), "kim's bot games")
        XCTAssertFalse(element(app, "profile.botsEmpty").exists)
        app.segmentedControls["profile.scope"].buttons["Human games"].tap()
        XCTAssertTrue(waitForStat(app, "gamesPlayed", humanGames))

        // Report: the reason prompt, then the server's thanks
        element(app, "profile.report").tap()
        let report = app.alerts["Report kim"]
        XCTAssertTrue(report.waitForExistence(timeout: 5))
        report.textFields.firstMatch.typeText("abusive chat")
        shot("player-profile-report")
        report.buttons["Submit Report"].tap()
        XCTAssertTrue(app.alerts["Safety"].staticTexts["Report submitted. Thank you."].waitForExistence(timeout: 5))
        app.alerts["Safety"].buttons["OK"].tap()
        XCTAssertTrue(waitForSent(app, containing: "reportUser:kim").contains("reportUser:kim"))

        // Block asks first; Cancel keeps them
        let block = element(app, "profile.block")
        XCTAssertEqual(block.label, "Block")
        block.tap()
        let confirm = app.alerts["Block kim?"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot("player-profile-block-confirm")
        confirm.buttons["Cancel"].tap()
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("blockUser:kim"))
        block.tap()
        XCTAssertTrue(app.alerts["Block kim?"].waitForExistence(timeout: 5))
        app.alerts["Block kim?"].buttons["Block"].tap()
        XCTAssertTrue(app.alerts["Safety"].staticTexts["Block list updated."].waitForExistence(timeout: 5))
        app.alerts["Safety"].buttons["OK"].tap()
        XCTAssertTrue(waitForLabel(block, "Unblock"), "the block list says kim is blocked: \(block.label)")
        shot("player-profile-blocked")
        // Unblock is direct
        block.tap()
        XCTAssertTrue(app.alerts["Safety"].waitForExistence(timeout: 5))
        app.alerts["Safety"].buttons["OK"].tap()
        XCTAssertTrue(waitForLabel(block, "Block"), block.label)
        XCTAssertTrue(Fixture.probe(app, "fixture.sent").contains("unblockUser:kim"))

        element(app, "profile.close").tap()
        XCTAssertFalse(element(app, "profile.name").waitForExistence(timeout: 2))
        app.terminate()
    }

    /// Another player's sheet at the largest text size: the name, Report and Block (stacked
    /// where they do not fit side by side) and every stat, all reachable by scrolling.
    func testPlayerProfileAtTheLargestTextSize() {
        let app = Fixture.launch("main-room", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"], env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        openProfileFromChat(app, line: "rematch?")
        XCTAssertEqual(element(app, "profile.name").label, "kim")
        let report = element(app, "profile.report"), block = element(app, "profile.block")
        XCTAssertTrue(report.waitForExistence(timeout: 6))
        let width = app.windows.firstMatch.frame.width
        for b in [report, block] {
            XCTAssertGreaterThanOrEqual(b.frame.minX, 0)
            XCTAssertLessThanOrEqual(b.frame.maxX, width + 1, "inside the sheet")
            XCTAssertGreaterThanOrEqual(b.frame.height, 44)
        }
        shot("player-profile-ax5")
        XCTAssertTrue(element(app, "profile.stat.gamesPlayed").waitForExistence(timeout: 6))
        let games = element(app, "profile.stat.gamesPlayed"), wins = element(app, "profile.stat.wins")
        reveal(app, wins)
        XCTAssertEqual(games.frame.midY, wins.frame.midY, accuracy: 2, "two cells side by side")
        shot("player-profile-ax5-stats")
        reveal(app, element(app, "profile.stat.hsi"))
        XCTAssertTrue(element(app, "profile.stat.hsi").isHittable)
        reveal(app, block)
        app.terminate()
    }

    /// The lobby and tournament chats have the same menu and sheet.
    func testViewProfileFromLobbyAndTournamentChat() {
        for fixture in ["game-lobby", "tournament-lobby"] {
            let app = Fixture.launch(fixture, env: env)
            XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), fixture)
            openProfileFromChat(app, line: "sure, joining the queue")
            XCTAssertEqual(element(app, "profile.name").label, "hal", fixture)
            XCTAssertTrue(element(app, "profile.report").waitForExistence(timeout: 5), fixture)
            app.terminate()
        }
    }

    /// The online list: a name opens the profile; my own name is not a button.
    func testOnlineListOpensProfile() {
        let app = Fixture.launch("main-room", env: env)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let online = app.buttons.matching(NSPredicate(format: "label == %@", "7 online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 5))
        online.tap()
        XCTAssertTrue(app.navigationBars["Online Players"].waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "online.ivy").exists, "my own row is just my name")
        let row = element(app, "online.ora")
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        row.tap()
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "profile.name").label, "ora")
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 5))
        app.terminate()
    }

    /// The table: a tap on a seat's avatar opens that player's profile; a bot seat says it has none.
    func testSeatAvatarOpensProfile() {
        var app = Fixture.launch("trick-mid-lead3", env: env)
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        tapSeat(app, name: "kim")
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5), "kim's seat opens the profile")
        XCTAssertEqual(element(app, "profile.name").label, "kim")
        XCTAssertTrue(element(app, "profile.block").waitForExistence(timeout: 5))
        shot("table-seat-profile")
        element(app, "profile.close").tap()
        XCTAssertFalse(element(app, "profile.name").waitForExistence(timeout: 2))
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", "the table is as it was")
        app.terminate()

        app = Fixture.launch("tournament-game", env: env)
        XCTAssertTrue(Fixture.readyElement(app, "tournament-game").waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        tapSeat(app, name: "🤖 Mike")
        XCTAssertTrue(element(app, "profile.notFound").waitForExistence(timeout: 6), "a bot has no profile")
        XCTAssertTrue(app.staticTexts["Bots don't have a profile."].exists)
        XCTAssertFalse(element(app, "profile.report").exists)
        shot("table-seat-bot")
        app.terminate()
    }

    /// Taps the avatar above a seat's name label (the scene reads each seat's name).
    private func tapSeat(_ app: XCUIApplication, name: String) {
        let label = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 5), "seat \(name)")
        let zoom = Fixture.tableZoom(app) ?? 1
        // the avatar's centre is 36 scene units above the name's baseline
        label.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 0, dy: -30 * zoom)).tap()
    }
}
