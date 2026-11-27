import XCTest

/// Launching the app in fixture mode (`-uiFixture`, DEBUG builds) and
/// reading its accessibility probes ("ui.pose", "table.layoutCheck",
/// "table.state", "table.zoom"). No socket, no voice, no network.
enum Fixture {
    static let tableFixtures = ["trick-mid-lead3", "bidding-mid", "between-tricks", "spectator-mid-hand", "lazy-at-seat",
                                "presence-mixed", "tournament-game", "draw-in-progress"]
    static let screenFixtures = ["main-room": "screen.mainRoom", "game-lobby": "screen.gameLobby",
                                 "main-room-cards": "screen.mainRoom", "game-lobby-reconnecting": "screen.gameLobby",
                                 "tournament-deadline": "screen.tournamentLobby", "tournament-results": "screen.tournamentLobby",
                                 "game-lobby-bots": "screen.gameLobby",
                                 "game-lobby-family": "screen.gameLobby", "game-lobby-family-full": "screen.gameLobby",
                                 "main-room-family": "screen.mainRoom",
                                 "tournament-lobby": "screen.tournamentLobby", "tournament-round": "screen.tournamentLobby",
                                 "tournament-between": "screen.tournamentLobby", "sign-in": "screen.signIn",
                                 "tournament-pairings": "screen.tournamentLobby", "tournament-rounds": "screen.tournamentLobby", "tournament-cut": "screen.tournamentLobby",
                                 "update-required": "updateRequired"]

    /// The element that says the fixture's screen is up.
    static func readyElement(_ app: XCUIApplication, _ fixture: String) -> XCUIElement {
        if fixture.hasPrefix("game-end") { return app.descendants(matching: .any)["gameEnd"] }
        if let id = screenFixtures[fixture] { return app.descendants(matching: .any)[id] }
        return app.buttons["leave"]
    }

    /// After New Game (Get Your Bid, 2026-11-25: New Game asks which game): the base game's
    /// choice, "Back Alley Bridge", as every live test before the second game meant.
    static func chooseClassicGame(timeout: TimeInterval = 5) {
        let choice = newGameChoice(XCUIApplication(), "classic")
        if choice.waitForExistence(timeout: timeout) { choice.tap() }
    }

    /// New Game's menu item (owner 2026-11-26: a native Menu whose items carry the rules as a
    /// subtitle, so the label may read "Back Alley Bridge, 4 players in two teams."): `classic`,
    /// `gyb` or `tournament`, by identifier or by the label's start.
    static func newGameChoice(_ app: XCUIApplication, _ mode: String) -> XCUIElement {
        let title = ["gyb": "Get Your Bid", "tournament": "Tournament"][mode] ?? "Back Alley Bridge"
        return app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@ OR label BEGINSWITH %@",
                                                "newGame.\(mode)", title, title + ",")).firstMatch
    }

    /// From the main room: New Game, then its Tournament choice (owner 2026-11-26: the trophy
    /// opens the leaderboard now; creating a tournament is New Game's third choice).
    static func createTournament(_ app: XCUIApplication, timeout: TimeInterval = 5) {
        app.buttons["New Game"].firstMatch.tap()
        let choice = newGameChoice(app, "tournament")
        // fail here, at the step that broke, not at a later wait for the tournament lobby
        XCTAssertTrue(choice.waitForExistence(timeout: timeout), "New Game's Tournament choice")
        choice.tap()
    }

    static func launch(_ fixture: String, extra: [String] = [], env: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiFixture", fixture] + extra
        app.launchEnvironment = env
        app.launch()
        return app
    }

    /// The system shows the vertical bar (the iPhone Duo closed, open in landscape, book pose:
    /// "ui.pose" ends "vbar <edge>"): the table's controls and my mic are bar items there.
    static func usesVerticalBar(_ app: XCUIApplication) -> Bool {
        let pose = probe(app, "ui.pose")
        return pose.contains(" vbar ") && !pose.hasSuffix("vbar -")
    }

    /// Touch and hold my mic for the voice panel: on the felt the hold opens it, in the vertical
    /// bar it opens the mic's menu, whose "Voice panel…" opens it (VoiceBarButton).
    static func holdForVoicePanel(_ app: XCUIApplication, _ mic: XCUIElement, duration: TimeInterval = 1.0) {
        mic.press(forDuration: duration)
        let item = app.buttons["Voice panel\u{2026}"]
        if item.waitForExistence(timeout: 1.5) { item.tap() }
    }

    static func probe(_ app: XCUIApplication, _ id: String) -> String {
        let e = app.descendants(matching: .any)[id]
        guard e.waitForExistence(timeout: 5) else { return "<no \(id)>" }
        return (e.value as? String) ?? "<nil>"
    }

    /// The table's zoom ("table.zoom", TableLayout.zoom): one scene unit is this many points.
    /// nil while the probe is missing or unparsable.
    static func tableZoom(_ app: XCUIApplication) -> CGFloat? {
        Double(probe(app, "table.zoom")).map { CGFloat($0) }
    }

    /// "466x678 0/0/34/84 topBar 70 fold - occlusions 0" -> (466, 678)
    static func windowSize(_ pose: String) -> CGSize? {
        let wh = pose.split(separator: " ").first?.split(separator: "x").compactMap { Double($0) } ?? []
        return wh.count == 2 ? CGSize(width: wh[0], height: wh[1]) : nil
    }

    static func insets(_ pose: String) -> (top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat)? {
        let parts = pose.split(separator: " ")
        guard parts.count > 1 else { return nil }
        let v = parts[1].split(separator: "/").compactMap { Double($0) }
        return v.count == 4 ? (v[0], v[1], v[2], v[3]) : nil
    }

    /// The Duo's poses by window size; anything else is "WxH".
    static func poseName(_ pose: String) -> String {
        guard let s = windowSize(pose) else { return "unknown" }
        switch (Int(s.width), Int(s.height)) {
        case (466, 678): return "closed"
        case (669, 951): return "open-portrait"
        case (951, 669): return "open-landscape"
        default: return "\(Int(s.width))x\(Int(s.height))"
        }
    }

    /// Waits for the probes to settle (the scene renders a frame after the view appears).
    static func settledState(_ app: XCUIApplication, timeout: TimeInterval = 5) -> String {
        var last = probe(app, "table.state")
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            let now = probe(app, "table.state")
            if now == last && now != "-" { return now }
            last = now
        }
        return last
    }
}
