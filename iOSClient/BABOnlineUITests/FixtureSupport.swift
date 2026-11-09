import XCTest

/// Launching the app in fixture mode (`-uiFixture`, DEBUG builds) and
/// reading its accessibility probes ("ui.pose", "table.layoutCheck",
/// "table.state"). No socket, no voice, no network.
enum Fixture {
    static let tableFixtures = ["trick-mid-lead3", "bidding-mid", "between-tricks", "spectator-mid-hand", "lazy-at-seat",
                                "presence-mixed", "tournament-game", "draw-in-progress"]
    static let screenFixtures = ["main-room": "screen.mainRoom", "game-lobby": "screen.gameLobby",
                                 "tournament-lobby": "screen.tournamentLobby", "tournament-round": "screen.tournamentLobby",
                                 "tournament-between": "screen.tournamentLobby", "sign-in": "screen.signIn"]

    /// The element that says the fixture's screen is up.
    static func readyElement(_ app: XCUIApplication, _ fixture: String) -> XCUIElement {
        if fixture == "game-end" { return app.descendants(matching: .any)["gameEnd"] }
        if let id = screenFixtures[fixture] { return app.descendants(matching: .any)[id] }
        return app.buttons["leave"]
    }

    static func launch(_ fixture: String, extra: [String] = [], env: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiFixture", fixture] + extra
        app.launchEnvironment = env
        app.launch()
        return app
    }

    static func probe(_ app: XCUIApplication, _ id: String) -> String {
        let e = app.descendants(matching: .any)[id]
        guard e.waitForExistence(timeout: 5) else { return "<no \(id)>" }
        return (e.value as? String) ?? "<nil>"
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
