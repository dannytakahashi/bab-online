import XCTest

/// The main room's New Game follows the session gate through a background and a foreground
/// (owner 2026-11-27 on the open Duo: "the start game spade can be greyed out" after a long
/// background, until the app was backgrounded and opened again). `-uiGateFlip <mode>:<ms>`
/// moves the gate around the scene's transitions as a live foreground does
/// (UIFixture+GateFlip); the probe `mainRoom.gate` is the gate itself, so a disabled New Game
/// with the gate open is the control not following it. Run on the Duo open in landscape (New
/// Game a vertical bar item, re-hosted while the app is away) and on a phone (the header):
/// on 2026-11-27 the bar followed the gate through 75 transitions in the simulator (every mode,
/// 0 to 600 ms), so a bar item left behind the gate is not the likely cause of that report. Away = another app in front: on the open Duo
/// `XCUIDevice.press(.home)` left the scene active (no background notification at all);
/// `TEST_RUNNER_BAB_GATE_AWAY=home` uses it anyway. `TEST_RUNNER_BAB_GATE_ROUNDS` /
/// `_MS` / `_MODES` widen a run.
final class SessionGateBarTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func newGame(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", "New Game")).firstMatch
    }

    private func gate(_ app: XCUIApplication) -> String {
        let probe = app.descendants(matching: .any)["mainRoom.gate"]
        return probe.exists ? (probe.value as? String ?? "?") : "-"
    }

    private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return condition()
    }

    /// Away and back `rounds` times; after each, once the gate is open again, New Game must be
    /// enabled.
    private func cycle(_ mode: String, rounds: Int, away: TimeInterval = 2) {
        let app = Fixture.launch("main-room", extra: ["-uiGateFlip", mode])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        let button = newGame(app)
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(wait(5) { button.isEnabled }, "New Game enabled at launch (gate \(gate(app)))")
        let other = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        for i in 1...rounds {
            if env["BAB_GATE_AWAY"] == "home" { XCUIDevice.shared.press(.home) } else { other.activate() }
            Thread.sleep(forTimeInterval: away)
            app.activate()
            XCTAssertTrue(wait(10) { gate(app).hasPrefix("ready=1 probing=0") }, "round \(i): the gate never opened: \(gate(app))")
            let on = wait(3) { button.isEnabled }
            print("[gate-test] \(mode) round \(i): gate \(gate(app)) enabled \(on)")
            if !on {
                let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                a.name = "gate-stuck-\(mode)-\(i)"
                a.lifetime = .keepAlways
                add(a)
            }
            XCTAssertTrue(on, "round \(i) (\(mode)): the gate is open (\(gate(app))) but New Game stays disabled")
        }
        app.terminate()
    }

    private var rounds: Int { Int(env["BAB_GATE_ROUNDS"] ?? "") ?? 2 }

    func testResumeFlips() {
        for ms in (env["BAB_GATE_MS"] ?? "0,120").split(separator: ",") {
            cycle("resume:\(ms)", rounds: rounds)
        }
    }

    func testRebuildFlips() {
        for ms in (env["BAB_GATE_MS"] ?? "0,120").split(separator: ",") {
            cycle("rebuild:\(ms)", rounds: rounds)
        }
    }

    func testFlipsWhileAway() {
        for ms in (env["BAB_GATE_MS"] ?? "0,120").split(separator: ",") {
            cycle("background:\(ms)", rounds: rounds, away: 3)
        }
    }

    func testFlipsDuringTheSnapshot() {
        for mode in (env["BAB_GATE_MODES"] ?? "snap:0,snap:300,snapflip:0,snapflip:250").split(separator: ",") {
            cycle(String(mode), rounds: rounds, away: 3)
        }
    }
}
