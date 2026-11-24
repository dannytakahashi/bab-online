#if os(iOS)
import Combine
import SwiftUI
import UIKit
import XCTest
@testable import BAB_Online

/// AppPresence on iOS (Platform/AppPresence{,+iOS}.swift): the scene phase's mapping to the
/// background / foreground effects (the mic, the socket's keep-alive, the connection check),
/// exactly what BABOnlineApp.handleScenePhase did, and the answers the table's sounds, the bid
/// tune and the admin panel's link read.
@MainActor
final class AppPresenceTests: XCTestCase {
    private final class Recorder: AppPresence.Target {
        var calls: [String] = []
        var isBackgroundTaskActive = false
        var isConnected = true
        func beginBackgroundKeepAlive() { calls.append("beginKeepAlive"); isBackgroundTaskActive = true }
        func endBackgroundKeepAlive() { calls.append("endKeepAlive"); isBackgroundTaskActive = false }
        func forceReconnect() { calls.append("forceReconnect") }
        func resumeAfterKeepAlive() { calls.append("resumeAfterKeepAlive") }
        func voiceBackgrounded() { calls.append("voiceBackground") }
        func voiceForegrounded() { calls.append("voiceForeground") }
    }

    private var recorder: Recorder!
    private var presence: AppPresence!
    private var heard: [AppPresence.Transition] = []
    private var bag: [Any] = []

    override func setUp() {
        super.setUp()
        let r = Recorder()
        recorder = r
        presence = AppPresence(target: { r })
        heard = []
        bag = [presence.transitions.sink { [unowned self] in self.heard.append($0) }]
    }

    /// The scene phases in order, and what each did (cleared between rows).
    private func run(_ phases: [ScenePhase]) -> [[String]] {
        phases.map { phase in
            recorder.calls = []
            presence.handleScenePhase(phase)
            return recorder.calls
        }
    }

    func testTheMappingTable() {
        // a launch: active, nothing to do
        XCTAssertEqual(run([.active]), [[]])
        // Control Center, the notification shade, a permission alert: inactive and back, no background
        XCTAssertEqual(run([.inactive, .active]), [[], []], "the socket was never at risk: nothing")
        XCTAssertFalse(presence.didEnterBackground)
        // a real background: the mic muted, then the keep-alive
        XCTAssertEqual(run([.inactive, .background]), [[], ["voiceBackground", "beginKeepAlive"]])
        XCTAssertTrue(presence.didEnterBackground)
        // back within the keep-alive, still connected: the mic back, the keep-alive ended
        XCTAssertEqual(run([.inactive, .active]), [[], ["voiceForeground", "endKeepAlive"]])
        XCTAssertFalse(presence.didEnterBackground)
        // a second active (inactive -> active again) does nothing
        XCTAssertEqual(run([.inactive, .active]), [[], []])
        XCTAssertEqual(heard, [.background, .foreground(withinKeepAlive: true)])
    }

    func testWithinTheKeepAliveButDisconnectedForcesAReconnect() {
        XCTAssertEqual(run([.background]), [["voiceBackground", "beginKeepAlive"]])
        recorder.isConnected = false
        XCTAssertEqual(run([.active]), [["voiceForeground", "endKeepAlive", "forceReconnect"]])
    }

    func testAfterTheKeepAliveTheConnectionIsChecked() {
        XCTAssertEqual(run([.background]), [["voiceBackground", "beginKeepAlive"]])
        recorder.isBackgroundTaskActive = false  // expired (or never granted)
        recorder.isConnected = false  // not proof either way: resumeAfterKeepAlive decides
        XCTAssertEqual(run([.active]), [["voiceForeground", "resumeAfterKeepAlive"]])
        XCTAssertEqual(heard, [.background, .foreground(withinKeepAlive: false)])
    }

    func testTwoBackgroundsBeforeAForegroundStartTheKeepAliveTwice() {
        // SocketService.beginBackgroundKeepAlive holds one task (its own guard), as before
        XCTAssertEqual(run([.background, .inactive, .background]),
                       [["voiceBackground", "beginKeepAlive"], [], ["voiceBackground", "beginKeepAlive"]])
        XCTAssertEqual(run([.active]), [["voiceForeground", "endKeepAlive"]])
    }

    func testTheTargetIsMadeOnTheFirstTransitionOnly() {
        var made = 0
        let r = Recorder()
        let p = AppPresence(target: { made += 1; return r })
        XCTAssertEqual(made, 0, "nothing touched at launch")
        p.handleScenePhase(.active)
        XCTAssertEqual(made, 0, "an active with no background reads nothing")
        p.handleScenePhase(.background)
        p.handleScenePhase(.active)
        XCTAssertEqual(made, 1)
    }

    func testSoundsPlayOnlyWhileTheAppIsActive() {
        XCTAssertTrue(AppPresence.mayPlaySound(.active))
        XCTAssertFalse(AppPresence.mayPlaySound(.inactive), "Notification Center, Control Center, the app switcher")
        XCTAssertFalse(AppPresence.mayPlaySound(.background))
    }

    func testTheNotificationsAreUIKits() {
        XCTAssertEqual(AppPresence.resignActiveNotifications,
                       [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification])
        XCTAssertEqual(AppPresence.becomeActiveNotification, UIApplication.didBecomeActiveNotification)
        XCTAssertEqual(AppPresence.coverNotifications.map(\.0),
                       [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification])
        XCTAssertEqual(AppPresence.coverNotifications.map(\.1), [true, false], "covered while not in front")
    }
}
#endif
