import XCTest

/// The admin panel in fixture mode (`-uiFixture main-room -uiAdmin <mode>`; the replies
/// come from UIFixture+Admin, which keeps a small roster in memory and changes it the way
/// the server does). Covers the entry (admins only), every section, the confirmations
/// (yes / no alerts, a name typed exactly, the rename's two fields), a refusal staying in
/// its sheet, the one-time reset link, forbidden and self-removal closing the panel, and no
/// answer, the main room header's Admin button, and a reset link whose answer lands on
/// another section. Each state is also saved as a kept screenshot attachment `admin-<name>`
/// (export with iOSClient/scripts/ios-screenshots.sh). Runs on any device.
final class AdminPanelUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - Helpers

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "admin-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func launch(_ mode: String?, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: (mode.map { ["-uiAdmin", $0] } ?? []) + extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        return app
    }

    /// The toast sits over the main room's header: a tap dismisses it.
    private func dismissToast(_ app: XCUIApplication) {
        for id in ["serverErrorToast", "infoToast"] {
            let toast = element(app, id)
            if toast.exists { toast.tap() }
            _ = toast.waitForNonExistence(timeout: 3)
        }
    }

    private func openAccount(_ app: XCUIApplication) {
        let settings = app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5))
    }

    /// The Admin entry sits under the profile, its statistics and its badges (iOS 1.2.2, 1.2.7),
    /// so it starts off screen on a phone: scroll the Account sheet until it (or, for a check
    /// that it is absent, the Password section right under it) is on screen.
    private func reveal(_ app: XCUIApplication, _ target: XCUIElement) {
        for _ in 0..<12 where !(target.exists && target.isHittable) { app.swipeUp(velocity: .slow) }
    }

    /// Main room -> Account -> Admin.
    @discardableResult
    private func openAdmin(_ mode: String = "ok", extra: [String] = []) -> XCUIApplication {
        let app = launch(mode, extra: extra)
        openAccount(app)
        let entry = element(app, "account.admin")
        reveal(app, entry)
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "an admin's Account sheet has the Admin entry")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Admin"].waitForExistence(timeout: 8), "the Admin entry opens the panel")
        return app
    }

    /// Scrolls the sheet's list up in short drags until `e` is built and can be tapped (lists
    /// build their rows lazily, and a long swipe on a small window can pass a row by).
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement, drags: Int = 24) {
        let window = app.windows.firstMatch
        for _ in 0..<drags where !(e.exists && e.isHittable) {
            let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
            let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
    }

    private func status(_ app: XCUIApplication) -> String {
        let s = element(app, "admin.status")
        return s.waitForExistence(timeout: 5) ? s.label : "<no status>"
    }

    private func waitForStatus(_ app: XCUIApplication, containing text: String, timeout: TimeInterval = 6) {
        let s = app.staticTexts.matching(NSPredicate(format: "identifier == 'admin.status' AND label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(s.waitForExistence(timeout: timeout), "status containing \"\(text)\"; it says: \(status(app))")
    }

    private func selectTab(_ app: XCUIApplication, _ title: String) {
        let segment = app.segmentedControls["admin.tabs"].buttons[title]
        XCTAssertTrue(segment.waitForExistence(timeout: 5), "tab \(title)")
        segment.tap()
    }

    private func type(_ app: XCUIApplication, _ id: String, _ text: String, replacing: Bool = false) {
        let field = app.textFields[id].firstMatch
        // a long sheet builds its lower rows only once they are scrolled to
        if !field.waitForExistence(timeout: 3) {
            reveal(app, field)
        }
        XCTAssertTrue(field.exists, id)
        field.tap()
        if replacing, let old = field.value as? String, !old.isEmpty, old != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        field.typeText(text)
    }

    /// Narrows the Players list to `name` (rows are built lazily; this brings one on screen).
    private func filterPlayers(_ app: XCUIApplication, _ name: String) {
        XCTAssertTrue(element(app, "admin.players.count").waitForExistence(timeout: 8), "the list loaded")
        type(app, "admin.players.filter", name, replacing: true)
    }

    private func openMenu(_ app: XCUIApplication, _ name: String, item: String) {
        let menu = app.buttons["admin.player.menu.\(name)"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 5), "menu of \(name)")
        menu.tap()
        let entry = app.buttons[item].firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 3), "menu item \(item)")
        entry.tap()
    }

    // MARK: - Entry

    func testNonAdminsHaveNoAdminEntry() {
        let app = launch(nil)
        openAccount(app)
        reveal(app, app.buttons["account.changePassword"])
        XCTAssertTrue(app.buttons["account.changePassword"].waitForExistence(timeout: 3))
        XCTAssertFalse(element(app, "account.admin").exists, "no Admin entry without the flag")
        XCTAssertFalse(app.buttons["mainRoom.admin"].exists, "nor the header's button")
    }

    // MARK: - Players

    func testPlayersListFilterSortAndResetLink() {
        let app = openAdmin()
        let count = element(app, "admin.players.count")
        XCTAssertTrue(count.waitForExistence(timeout: 8))
        XCTAssertEqual(count.label, "13 accounts.")
        // newest first: the top rows
        let first = element(app, "admin.player.AlanB")
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        XCTAssertTrue(first.label.contains("Games 1"), first.label)
        XCTAssertTrue(first.label.contains("Bot games 1"), first.label)
        XCTAssertTrue(element(app, "admin.player.ghost").label.contains("deleted, name held until"), "a held name says so")
        shot(app, "players")

        // sort by player name: Alan first, then alan2
        element(app, "admin.players.sortMenu").tap()
        app.buttons["Player"].firstMatch.tap()
        let alan = element(app, "admin.player.Alan"), alan2 = element(app, "admin.player.alan2")
        XCTAssertTrue(alan.waitForExistence(timeout: 3))
        XCTAssertLessThan(alan.frame.minY, alan2.frame.minY)
        XCTAssertLessThan(alan2.frame.minY, element(app, "admin.player.AlanB").frame.minY)

        // filter: the name, or the account a tombstone points at
        filterPlayers(app, "kim")
        XCTAssertEqual(count.label, "2 of 13 accounts match \"kim\".")
        let kim = element(app, "admin.player.kim")
        XCTAssertTrue(kim.exists)
        XCTAssertTrue(kim.label.contains("online"), kim.label)
        XCTAssertTrue(kim.label.contains("Last seen now"), kim.label)
        XCTAssertTrue(element(app, "admin.player.kim2").label.contains("merged into kim"))

        // the one-time link: shown once, with Copy and Share
        openMenu(app, "kim", item: "Reset link")
        let url = element(app, "admin.resetLink.url")
        XCTAssertTrue(url.waitForExistence(timeout: 5), "the link's sheet")
        // VoiceOver names the row and never reads the link (a bearer secret) aloud
        XCTAssertEqual(url.label, "Reset link")
        XCTAssertEqual(url.value as? String, "On screen. Use Copy or Share to pass it on.")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Shown once: copy it now. It works once, until ")).firstMatch.exists)
        XCTAssertTrue(app.buttons["admin.resetLink.share"].exists)
        shot(app, "reset-link")
        app.buttons["admin.resetLink.copy"].tap()
        XCTAssertTrue(app.staticTexts["Link copied. Text it to the player."].waitForExistence(timeout: 3))
        app.buttons["admin.resetLink.done"].tap()
        waitForStatus(app, containing: "Reset link made for kim.")
        XCTAssertFalse(status(app).contains("reset#"), "the link is never in the status line")
        let sent = Fixture.probe(app, "fixture.sent")
        XCTAssertTrue(sent.contains("admin:createResetLink:kim"), sent)

        // a filter with no match
        filterPlayers(app, "zzzz")
        XCTAssertTrue(app.staticTexts["No account matches the filter."].waitForExistence(timeout: 3))
    }

    func testSignOutEverywhereAsksFirst() {
        let app = openAdmin()
        filterPlayers(app, "hal")
        openMenu(app, "hal", item: "Sign out everywhere…")
        let alert = app.alerts["Sign hal out everywhere?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "goes back to the sign-in screen")).firstMatch.exists)
        shot(app, "confirm-sign-out")
        alert.buttons["Cancel"].tap()
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("signOutEverywhere"), "Cancel sends nothing")

        openMenu(app, "hal", item: "Sign out everywhere…")
        app.alerts.firstMatch.buttons["Sign out everywhere"].tap()
        waitForStatus(app, containing: "hal is signed out: 2 saved session(s) revoked, 1 live connection(s) closed.")
        XCTAssertFalse(element(app, "admin.player.hal").label.contains("online"), "the reloaded row")
    }

    func testDeleteNeedsTheExactNameAndARefusalStaysInTheSheet() {
        let app = openAdmin()
        // my own account: refused before anything is typed
        filterPlayers(app, "ivy")
        openMenu(app, "ivy", item: "Delete account…")
        waitForStatus(app, containing: "To delete your own account, use Delete account on your profile")
        XCTAssertFalse(element(app, "admin.confirm.field").exists)

        filterPlayers(app, "hal")
        openMenu(app, "hal", item: "Delete account…")
        let submit = app.buttons["admin.confirm.submit"]
        XCTAssertTrue(element(app, "admin.confirm.title").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "admin.confirm.title").label, "Delete hal?")
        // the six consequences come first; the field and the button are below them
        reveal(app, submit)
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(submit.isEnabled, "nothing typed")
        type(app, "admin.confirm.field", "Hal")
        XCTAssertFalse(submit.isEnabled, "capital letters count")
        type(app, "admin.confirm.field", "hal ", replacing: true)
        XCTAssertFalse(submit.isEnabled, "a trailing space counts")
        type(app, "admin.confirm.field", "hal", replacing: true)
        XCTAssertTrue(submit.isEnabled)
        shot(app, "delete-typed")
        submit.tap()
        // the fixture's hal is in a game: the server's refusal stays in the sheet
        let refusal = element(app, "admin.confirm.alert")
        XCTAssertTrue(refusal.waitForExistence(timeout: 5))
        XCTAssertTrue(refusal.label.contains("is in a game right now"), refusal.label)
        XCTAssertTrue(submit.exists, "the sheet stays open")
        shot(app, "delete-refused")
        reveal(app, app.buttons["admin.confirm.cancel"])
        app.buttons["admin.confirm.cancel"].tap()

        filterPlayers(app, "pat")
        openMenu(app, "pat", item: "Delete account…")
        type(app, "admin.confirm.field", "pat")
        // the button sits under the field, below the fold on a phone (iOS 27's taller rows put
        // the field at the bottom of an iPhone 18 Pro's sheet, the button's row not yet built)
        let patSubmit = app.buttons["admin.confirm.submit"]
        reveal(app, patSubmit)
        XCTAssertTrue(patSubmit.isEnabled, "the exact name")
        patSubmit.tap()
        waitForStatus(app, containing: "pat is deleted: 3 game record update(s) to [deleted], 1 report(s) marked, 0 live connection(s) closed.")
        XCTAssertFalse(app.buttons["admin.confirm.submit"].exists, "the sheet closed")
        XCTAssertTrue(element(app, "admin.player.pat").label.contains("deleted, name held until"), "the name is held")

        // the held name can be freed, with its own words
        openMenu(app, "pat", item: "Free name…")
        XCTAssertTrue(element(app, "admin.confirm.title").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "admin.confirm.title").label, "Free the name pat?")
        type(app, "admin.confirm.field", "pat")
        let freeSubmit = app.buttons["admin.confirm.submit"]
        reveal(app, freeSubmit)
        freeSubmit.tap()
        waitForStatus(app, containing: "The name pat is free again.")
    }

    func testRenameTakesTheNameTwice() {
        let app = openAdmin()
        filterPlayers(app, "alan2")
        openMenu(app, "alan2", item: "Rename…")
        let submit = app.buttons["admin.rename.submit"]
        XCTAssertTrue(app.navigationBars["Rename alan2"].waitForExistence(timeout: 5))
        reveal(app, submit)
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(submit.isEnabled)
        type(app, "admin.rename.new", "kim")
        XCTAssertFalse(submit.isEnabled, "typed once")
        type(app, "admin.rename.again", "Kim")
        XCTAssertFalse(submit.isEnabled, "the second field must match exactly")
        type(app, "admin.rename.again", "kim", replacing: true)
        XCTAssertTrue(submit.isEnabled)
        XCTAssertEqual(element(app, "admin.rename.summary").label, "alan2 becomes kim")
        submit.tap()
        let refusal = element(app, "admin.rename.alert")
        XCTAssertTrue(refusal.waitForExistence(timeout: 5))
        XCTAssertEqual(refusal.label, "That name is taken.")
        shot(app, "rename-refused")

        type(app, "admin.rename.new", "Alan Two", replacing: true)
        type(app, "admin.rename.again", "Alan Two", replacing: true)
        XCTAssertTrue(submit.isEnabled)
        submit.tap()
        waitForStatus(app, containing: "alan2 is now called Alan Two: 1 live connection(s) signed out")
        // the old name stays as a redirect
        XCTAssertTrue(element(app, "admin.player.alan2").waitForExistence(timeout: 3))
        XCTAssertTrue(element(app, "admin.player.alan2").label.contains("renamed to Alan Two"))

        // an unfinished rename is finished from its row
        filterPlayers(app, "max")
        XCTAssertTrue(element(app, "admin.player.max").label.contains("rename unfinished"))
        openMenu(app, "max", item: "Finish rename")
        let alert = app.alerts["Finish renaming maxx to max?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        alert.buttons["Finish rename"].tap()
        waitForStatus(app, containing: "The rename of maxx to max is finished")
        XCTAssertFalse(element(app, "admin.player.max").label.contains("rename unfinished"))
    }

    // MARK: - Reports

    func testReportsResolveWithANote() {
        let app = openAdmin()
        selectTab(app, "Reports")
        let first = String(format: "%024x", 9001)
        XCTAssertTrue(app.buttons["admin.report.resolve.\(first)"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Abusive chat"].exists)
        shot(app, "reports")
        let note = app.descendants(matching: .any)["admin.report.note.\(first)"].firstMatch
        note.tap()
        note.typeText("Warned in chat")
        app.buttons["admin.report.resolve.\(first)"].tap()
        waitForStatus(app, containing: "Report resolved.")
        XCTAssertFalse(app.buttons["admin.report.resolve.\(first)"].exists, "a closed report leaves the open list")

        app.segmentedControls["admin.reports.filter"].buttons["All"].tap()
        let resolution = element(app, "admin.report.resolution.\(first)")
        XCTAssertTrue(resolution.waitForExistence(timeout: 5))
        XCTAssertTrue(resolution.label.hasPrefix("Resolved by ivy "), resolution.label)
        XCTAssertTrue(resolution.label.hasSuffix(": Warned in chat"), resolution.label)

        // the reported name opens that player under Players
        element(app, "admin.report.player.\(first)").tap()
        XCTAssertTrue(element(app, "admin.player.hal").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "admin.players.count").label, "1 of 13 accounts match \"hal\".")
    }

    // MARK: - Admins

    func testAdminsRemoveAndRemovingMyselfClosesThePanel() {
        let app = openAdmin()
        selectTab(app, "Admins")
        let me = element(app, "admin.admins.row.ivy")
        XCTAssertTrue(me.waitForExistence(timeout: 8))
        XCTAssertTrue(me.label.contains("ivy (you)"), me.label)
        XCTAssertTrue(element(app, "admin.admins.row.jon").exists)
        shot(app, "admins")

        app.buttons["admin.admins.remove.jon"].tap()
        let alert = app.alerts["Remove jon's admin?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        XCTAssertTrue(alert.staticTexts["jon loses access to this panel at once."].exists)
        alert.buttons["Remove admin"].tap()
        waitForStatus(app, containing: "jon is no longer an admin.")
        XCTAssertFalse(element(app, "admin.admins.row.jon").exists)

        // the only admin left cannot remove themselves
        app.buttons["admin.admins.remove.ivy"].tap()
        XCTAssertTrue(app.alerts["Remove ivy's admin?"].staticTexts["You will lose access to this panel at once."].waitForExistence(timeout: 3))
        app.alerts.firstMatch.buttons["Remove admin"].tap()
        waitForStatus(app, containing: "\"ivy\" is the only admin. Make someone else an admin first.")
        XCTAssertTrue(app.navigationBars["Admin"].exists)

        // with another admin, removing myself closes the panel and hides the entry
        selectTab(app, "Players")
        filterPlayers(app, "kim")
        openMenu(app, "kim", item: "Make admin…")
        XCTAssertTrue(app.alerts["Make kim an admin?"].waitForExistence(timeout: 3))
        app.alerts.firstMatch.buttons["Make admin"].tap()
        waitForStatus(app, containing: "kim is now an admin.")
        filterPlayers(app, "ivy")
        openMenu(app, "ivy", item: "Remove admin…")
        app.alerts.firstMatch.buttons["Remove admin"].tap()
        // news I asked for: the info toast (toast audit 2026-11-18), not the refusal's
        let toast = element(app, "infoToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8))
        XCTAssertTrue(toast.label.contains("You are no longer an admin."), toast.label)
        XCTAssertTrue(app.navigationBars["Admin"].waitForNonExistence(timeout: 5), "the panel closed")
        dismissToast(app)
        openAccount(app)
        reveal(app, app.buttons["account.changePassword"])
        XCTAssertFalse(element(app, "account.admin").exists, "the entry is gone")
    }

    // MARK: - The header's entry, and a slow reset link

    func testTheMainRoomHeaderOpensThePanelForAdmins() {
        let app = launch("ok")
        let entry = app.buttons["mainRoom.admin"].firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "an admin's main room has the Admin button (the web's header)")
        XCTAssertEqual(entry.label, "Admin")
        shot(app, "header-entry")
        entry.tap()
        XCTAssertTrue(app.navigationBars["Admin"].waitForExistence(timeout: 8))
        XCTAssertTrue(element(app, "admin.players.count").waitForExistence(timeout: 8))
        app.buttons["admin.close"].tap()
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
    }

    /// The link's answer lands after the section changed: its sheet still comes up (the
    /// server has cancelled the player's earlier link by then), the panel cannot be closed
    /// while it is on its way, and the link is back after the app left the front.
    func testAResetLinkThatArrivesOnAnotherSectionIsStillShown() {
        let app = openAdmin(extra: ["-uiAdminLinkDelay", "8"])
        filterPlayers(app, "kim")
        openMenu(app, "kim", item: "Reset link")
        XCTAssertFalse(app.buttons["admin.close"].isEnabled, "a change on its way: Close waits")
        XCTAssertFalse(app.buttons["admin.player.menu.kim"].firstMatch.isEnabled, "no second link, no other dialog meanwhile")
        selectTab(app, "Audit")
        let url = element(app, "admin.resetLink.url")
        XCTAssertTrue(url.waitForExistence(timeout: 20), "the link's sheet over the Audit section")
        shot(app, "reset-link-other-section")
        // shown once: only Done closes it, never a tap beside the sheet (the iPad) or a swipe
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(url.waitForExistence(timeout: 3), "still there")

        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(url.waitForExistence(timeout: 10), "in front again: the link is shown again")
        XCTAssertFalse(element(app, "admin.resetLink.covered").exists)
        app.buttons["admin.resetLink.done"].tap()
        XCTAssertTrue(app.buttons["admin.close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["admin.close"].isEnabled)
        let sent = Fixture.probe(app, "fixture.sent")
        XCTAssertEqual(sent.components(separatedBy: "admin:createResetLink").count - 1, 1, sent)
    }

    // MARK: - Audit

    func testAuditPagesBack() {
        let app = openAdmin()
        selectTab(app, "Audit")
        let newest = element(app, "admin.audit.row.\(String(format: "%024x", 1000))")
        XCTAssertTrue(newest.waitForExistence(timeout: 8))
        XCTAssertTrue(newest.label.contains("createResetLink"), newest.label)
        shot(app, "audit")
        let more = app.buttons["admin.audit.more"]
        for _ in 0..<40 where !more.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(more.exists, "50 rows, then Load more")
        more.doubleTap()  // the second tap asks nothing: one page, no row twice
        let oldest = element(app, "admin.audit.row.\(String(format: "%024x", 941))")
        for _ in 0..<20 where !oldest.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(oldest.exists, "the second page's last row")
        XCTAssertFalse(more.exists, "nothing more after the last page")
    }

    // MARK: - Merge

    func testMergePreviewAndTypedApply() {
        let app = openAdmin()
        selectTab(app, "Merge")
        app.buttons["admin.merge.preview"].tap()
        waitForStatus(app, containing: "Name the account to keep and at least one account to merge into it.")

        app.buttons["admin.merge.findDuplicates"].tap()
        let use = app.buttons["admin.merge.use.0"]
        XCTAssertTrue(use.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Alan (30 games, 2 bot), alan2 (4 games, 0 bot), AlanB (1 games, 1 bot)"].exists)
        use.tap()
        XCTAssertEqual(app.textFields["admin.merge.keep"].value as? String, "Alan")
        XCTAssertEqual(app.textFields["admin.merge.sources"].value as? String, "alan2, AlanB")
        app.buttons["admin.merge.preview"].tap()
        waitForStatus(app, containing: "Preview ready: 13 change(s).")

        let result = element(app, "admin.merge.account.result.Alan")
        reveal(app, result)
        XCTAssertTrue(result.exists)
        XCTAssertTrue(result.label.contains("Games 35"), result.label)
        XCTAssertTrue(result.label.contains("Bot games 3"), result.label)
        shot(app, "merge-plan")
        // (how much of the plan is built at once depends on the sheet's height)
        let stats = app.staticTexts["gamesPlayed: 30 → 35"], botStats = app.staticTexts["gamesPlayed: 2 → 3"]
        reveal(app, stats)
        XCTAssertTrue(stats.exists, "Stats that change")
        reveal(app, botStats)
        XCTAssertTrue(botStats.exists, "Bot-game stats that change")

        let apply = app.buttons["admin.merge.apply"]
        reveal(app, apply)
        XCTAssertTrue(apply.exists)
        XCTAssertTrue(app.staticTexts["13 change(s) planned."].exists)
        XCTAssertFalse(apply.isEnabled, "the kept name is not typed yet")
        type(app, "admin.merge.confirm", "alan")
        XCTAssertFalse(apply.isEnabled, "exactly: capital letters count")
        type(app, "admin.merge.confirm", "Alan", replacing: true)
        XCTAssertTrue(apply.isEnabled)
        shot(app, "merge-confirm")
        apply.tap()
        waitForStatus(app, containing: "Merged into Alan.")
        XCTAssertTrue(app.staticTexts["Retired: alan2, AlanB"].waitForExistence(timeout: 3))
        shot(app, "merge-done")
        let sent = Fixture.probe(app, "fixture.sent")
        XCTAssertTrue(sent.contains("admin:planMerge:Alan|admin:applyMerge:Alan"), sent)

        // the merged names are tombstones of Alan now
        selectTab(app, "Players")
        filterPlayers(app, "alan2")
        XCTAssertTrue(element(app, "admin.player.alan2").label.contains("merged into Alan"))
    }

    func testAStalePlanGoesBackToPreview() {
        let app = openAdmin("stale")
        selectTab(app, "Merge")
        type(app, "admin.merge.keep", "Alan")
        type(app, "admin.merge.sources", "alan2")
        app.buttons["admin.merge.preview"].tap()
        waitForStatus(app, containing: "Preview ready:")
        let apply = app.buttons["admin.merge.apply"]
        reveal(app, apply)
        type(app, "admin.merge.confirm", "Alan")
        apply.tap()
        let note = element(app, "admin.merge.note")
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertEqual(note.label, "These accounts changed since the preview. Preview again before merging.")
        XCTAssertFalse(apply.exists, "the preview is spent")
        shot(app, "merge-stale")
    }

    func testAPlanWithErrorsShowsThemAndNothingToApply() {
        let app = openAdmin()
        selectTab(app, "Merge")
        type(app, "admin.merge.keep", "Alan")
        type(app, "admin.merge.sources", "jon, nobody")
        app.buttons["admin.merge.preview"].tap()
        waitForStatus(app, containing: "The merge cannot be done: see the errors.")
        XCTAssertTrue(app.staticTexts["Source \"jon\" is an admin. Remove their admin first."].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["No account is named \"nobody\" (names are case-sensitive)."].exists)
        XCTAssertFalse(app.buttons["admin.merge.apply"].exists)
        shot(app, "merge-errors")
    }

    // MARK: - Access and connection

    func testForbiddenClosesThePanelAndHidesTheEntry() {
        let app = launch("forbidden")
        openAccount(app)
        reveal(app, element(app, "account.admin"))
        element(app, "account.admin").tap()
        let toast = element(app, "serverErrorToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 10))
        XCTAssertTrue(toast.label.contains("Admin access is not available on this connection."), toast.label)
        XCTAssertTrue(app.navigationBars["Admin"].waitForNonExistence(timeout: 5), "the panel closed")
        shot(app, "forbidden")
        dismissToast(app)
        openAccount(app)
        reveal(app, app.buttons["account.changePassword"])
        XCTAssertFalse(element(app, "account.admin").exists, "the entry is hidden")
    }

    func testNoAnswerIsSaidAndThePanelStays() {
        let app = openAdmin("silent")
        waitForStatus(app, containing: "No answer from the server. Check the connection and try again.")
        XCTAssertTrue(app.navigationBars["Admin"].exists)
        shot(app, "no-answer")
        app.buttons["admin.close"].tap()
        XCTAssertTrue(app.navigationBars["Admin"].waitForNonExistence(timeout: 5))
    }

    func testTheCappedListSaysSo() {
        let app = openAdmin("capped")
        let cap = element(app, "admin.players.cap")
        XCTAssertTrue(cap.waitForExistence(timeout: 8))
        XCTAssertEqual(cap.label, "Showing the newest 13 of 333 accounts. Sorting and the filter cover only these.")
        XCTAssertEqual(element(app, "admin.players.count").label, "13 accounts (of 333).")
    }

    /// The largest accessibility type size: the section control is a menu, a row's actions
    /// stay reachable and the typed confirmation still works.
    func testAccessibilityTypeSize() {
        let app = openAdmin(extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssertTrue(element(app, "admin.players.count").waitForExistence(timeout: 8))
        XCTAssertFalse(app.segmentedControls["admin.tabs"].exists, "five segments would be cut: a menu instead")
        shot(app, "players-ax")
        let menu = app.buttons["admin.player.menu.AlanB"].firstMatch
        reveal(app, menu)
        XCTAssertTrue(menu.isHittable)
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(menu.frame.maxX, window.maxX, "the menu button is on screen")
        menu.tap()
        app.buttons["Delete account…"].firstMatch.tap()
        XCTAssertTrue(element(app, "admin.confirm.title").waitForExistence(timeout: 5))
        shot(app, "delete-typed-ax")
        // the consequences fill the sheet at this size: the field and the button are below
        let submit = app.buttons["admin.confirm.submit"]
        reveal(app, submit)
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(submit.isEnabled)
        reveal(app, app.buttons["admin.confirm.cancel"])
        app.buttons["admin.confirm.cancel"].tap()

        let tabs = element(app, "admin.tabs")
        XCTAssertTrue(tabs.waitForExistence(timeout: 3))
        tabs.tap()
        app.buttons["Reports"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Abusive chat"].waitForExistence(timeout: 8))
        shot(app, "reports-ax")
    }
}
