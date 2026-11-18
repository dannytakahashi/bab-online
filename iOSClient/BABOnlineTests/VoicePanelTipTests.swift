import XCTest
@testable import BAB_Online

/// The voice panel tip (Voice/VoicePanelTip.swift): once per install, the first time a mic button
/// is on screen with voice on; seen when shown or when a long press opens the panel first.
@MainActor
final class VoicePanelTipTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    /// The tip's scheduled work, run by hand (`run`).
    private var scheduled: [(delay: TimeInterval, run: @MainActor () -> Void)] = []
    private var announced: [String] = []

    override func setUp() {
        suite = "VoicePanelTipTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        scheduled = []
        announced = []
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func makeTip(suppressed: Bool = false) -> VoicePanelTip {
        VoicePanelTip(defaults: defaults, suppressed: suppressed,
                      after: { [unowned self] delay, run in self.scheduled.append((delay, run)) },
                      announce: { [unowned self] in self.announced.append($0) })
    }

    /// Runs what is scheduled now (not what that schedules in turn).
    private func runScheduled() {
        let now = scheduled
        scheduled = []
        for item in now { item.run() }
    }

    // MARK: - The rule

    func testTheRuleShowsOnlyAnUnseenUncoveredTipWithVoiceOnAndTheMicOnScreen() {
        for seen in [false, true] {
            for voice in [false, true] {
                for mic in [false, true] {
                    for covered in [false, true] {
                        for suppressed in [false, true] {
                            XCTAssertEqual(VoicePanelTipRule.shouldShow(seen: seen, voiceActive: voice, micVisible: mic,
                                                                        covered: covered, suppressed: suppressed),
                                           !seen && voice && mic && !covered && !suppressed,
                                           "seen \(seen) voice \(voice) mic \(mic) covered \(covered) suppressed \(suppressed)")
                        }
                    }
                }
            }
        }
    }

    func testTestLaunchesNeverShowItUnlessAFixtureAsks() {
        XCTAssertFalse(VoicePanelTipRule.suppressed(testHost: false, uiTestLaunch: false, fixtureAsks: false), "a real launch")
        XCTAssertTrue(VoicePanelTipRule.suppressed(testHost: true, uiTestLaunch: false, fixtureAsks: false), "unit tests")
        XCTAssertTrue(VoicePanelTipRule.suppressed(testHost: false, uiTestLaunch: true, fixtureAsks: false), "a UI test")
        XCTAssertFalse(VoicePanelTipRule.suppressed(testHost: false, uiTestLaunch: true, fixtureAsks: true), "-uiVoiceTip YES")
    }

    func testTheTextNamesTheGlyphOnTheButton() {
        XCTAssertEqual(VoicePanelTipRule.text(listenOnly: false), "Tip: touch and hold the mic for the voice panel")
        XCTAssertEqual(VoicePanelTipRule.text(listenOnly: true), "Tip: touch and hold the headphones for the voice panel")
    }

    // MARK: - The coordinator

    func testItShowsOnceAfterTheMicAppearsAndIsSeenAsItShows() {
        let tip = makeTip()
        let mic = UUID()
        tip.mic(mic, visible: true, voiceActive: true, listenOnly: false)
        XCTAssertNil(tip.text, "not at once")
        XCTAssertFalse(tip.seen)
        XCTAssertEqual(scheduled.map(\.delay), [VoicePanelTip.showDelay])
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.micText)
        XCTAssertTrue(tip.seen, "seen once shown")
        XCTAssertEqual(announced, [VoicePanelTipRule.micText], "VoiceOver hears it once")
        XCTAssertEqual(scheduled.map(\.delay), [VoicePanelTip.visibleSeconds], "the auto-dismiss")
        runScheduled()
        XCTAssertNil(tip.text, "gone after a few seconds")

        // the next mic, and the next launch (the same defaults), show nothing
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        XCTAssertTrue(scheduled.isEmpty)
        let next = makeTip()
        next.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertNil(next.text)
        XCTAssertEqual(announced.count, 1)
    }

    func testATapDismissesItAndTheOldTimerLeavesTheNextAlone() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertNotNil(tip.text)
        tip.dismiss()
        XCTAssertNil(tip.text)
        runScheduled()  // the stale auto-dismiss
        XCTAssertNil(tip.text)
    }

    func testOpeningThePanelFirstMeansNoTip() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        tip.panelOpened()  // a long press inside the delay
        runScheduled()
        XCTAssertNil(tip.text)
        XCTAssertTrue(tip.seen)
        XCTAssertTrue(announced.isEmpty)

        // a long press before any mic was reported: nothing is ever scheduled
        defaults.removeObject(forKey: VoicePanelTip.seenKey)
        let other = makeTip()
        other.panelOpened()
        other.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        XCTAssertTrue(scheduled.isEmpty)
    }

    func testOpeningThePanelWhileItShowsHidesIt() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertNotNil(tip.text)
        tip.panelOpened()
        XCTAssertNil(tip.text)
    }

    func testAMicThatLeavesBeforeTheDelayShowsNothingAndTheNextOneDoes() {
        let tip = makeTip()
        let lobby = UUID()
        tip.mic(lobby, visible: true, voiceActive: true, listenOnly: false)
        tip.mic(lobby, visible: false, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertNil(tip.text)
        XCTAssertFalse(tip.seen, "never shown: still to come")
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.micText)
    }

    func testAButtonWithoutVoiceWaitsForVoice() {
        let tip = makeTip()
        let mic = UUID()
        tip.mic(mic, visible: true, voiceActive: false, listenOnly: false)
        XCTAssertTrue(scheduled.isEmpty)
        tip.mic(mic, visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.micText)
    }

    func testTwoMicsOnScreenScheduleOneTip() {
        let tip = makeTip()
        let a = UUID(), b = UUID()
        tip.mic(a, visible: true, voiceActive: true, listenOnly: false)
        tip.mic(b, visible: true, voiceActive: true, listenOnly: false)
        XCTAssertEqual(scheduled.count, 1)
        tip.mic(a, visible: false, voiceActive: true, listenOnly: false)  // the lobby's goes, the table's stays
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.micText)
        XCTAssertEqual(announced.count, 1)
    }

    func testAListenOnlySpectatorIsToldAboutTheHeadphones() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: true)
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.headphonesText)
    }

    func testASuppressedLaunchNeverShowsItNorMarksItSeen() {
        let tip = makeTip(suppressed: true)
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        XCTAssertNil(tip.text)
        XCTAssertFalse(tip.seen)
    }

    func testTheSharedTipIsSuppressedUnderXCTest() {
        XCTAssertTrue(VoicePanelTip.launchSuppressed, "a unit-test host")
        XCTAssertTrue(VoicePanelTip.shared.suppressed)
    }

    // MARK: - Covers (the draw / game-end overlay, the log drawer, another toast)

    func testACoveredTableWaitsAndTheTipIsNotUsedUp() {
        let tip = makeTip()
        tip.cover(.table, true)  // a spectator joining in the draw phase: the pill under the scrim
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: true)
        runScheduled()
        XCTAssertNil(tip.text)
        XCTAssertFalse(tip.seen, "still to come")
        XCTAssertTrue(scheduled.isEmpty)
        tip.cover(.table, false)  // the deal: the table shows
        XCTAssertEqual(scheduled.map(\.delay), [VoicePanelTip.showDelay])
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.headphonesText)
        XCTAssertTrue(tip.seen)
    }

    func testACoverInsideTheDelayHoldsItUntilEveryCoverIsGone() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        tip.cover(.notice, true)
        tip.cover(.connection, true)
        runScheduled()
        XCTAssertNil(tip.text)
        XCTAssertFalse(tip.seen)
        tip.cover(.notice, false)
        runScheduled()
        XCTAssertNil(tip.text, "the connection toast is still up")
        tip.cover(.connection, false)
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.micText)
    }

    func testANoticeWhileItShowsHidesItAndItComesBackForItsFullTimeAnnouncedOnce() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: true)
        runScheduled()
        XCTAssertNotNil(tip.text)
        scheduled = []  // drop the first auto-dismiss: the stale one is tested below
        tip.cover(.notice, true)  // a tap on the headphones: "tap to talk" in the same spot
        XCTAssertNil(tip.text, "hidden under the notice")
        XCTAssertTrue(scheduled.isEmpty)
        tip.cover(.notice, false)
        runScheduled()
        XCTAssertEqual(tip.text, VoicePanelTipRule.headphonesText, "back once the notice goes")
        XCTAssertEqual(scheduled.map(\.delay), [VoicePanelTip.visibleSeconds], "its full time again")
        XCTAssertEqual(announced.count, 1, "VoiceOver heard it the first time")
        runScheduled()
        XCTAssertNil(tip.text)
        // gone for good: no cover brings it back
        tip.cover(.notice, true)
        tip.cover(.notice, false)
        runScheduled()
        XCTAssertNil(tip.text)
    }

    func testTheFirstTimersAutoDismissLeavesTheReshownTipAlone() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        let firstTimer = scheduled
        scheduled = []
        tip.cover(.table, true)
        tip.cover(.table, false)
        runScheduled()
        XCTAssertNotNil(tip.text)
        for item in firstTimer { item.run() }
        XCTAssertNotNil(tip.text, "the first showing's timer is stale")
    }

    func testAnInterruptedTipThatIsTappedOrOpenedStaysGone() {
        let tip = makeTip()
        tip.mic(UUID(), visible: true, voiceActive: true, listenOnly: false)
        runScheduled()
        tip.cover(.table, true)
        tip.panelOpened()  // the person found the panel meanwhile
        tip.cover(.table, false)
        runScheduled()
        XCTAssertNil(tip.text)
    }
}
