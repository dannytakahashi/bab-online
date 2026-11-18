import SwiftUI

/// Whether the voice panel tip shows (owner 2026-11-17): the panel (VoicePanelSheet) opens only
/// by touching and holding the mic button, so the first time a mic button is on screen with
/// voice on (lobby header, my seat's row, a spectator's pill) a toast says so, once per install.
/// Pure, so the unit tests read every case (VoicePanelTipTests).
enum VoicePanelTipRule {
    /// Not seen yet (shown before, or the panel already opened by a long press), voice on and its
    /// button on screen, and not a test launch that did not ask for it.
    static func shouldShow(seen: Bool, voiceActive: Bool, micVisible: Bool, suppressed: Bool) -> Bool {
        !seen && voiceActive && micVisible && !suppressed
    }

    /// A unit-test host or an Xcode preview never shows it; a UI test launch (fixture mode, or a
    /// live test's `-serverURL`) only when its fixture asks (`-uiVoiceTip YES`), so no other UI
    /// test finds a toast over the table.
    static func suppressed(testHost: Bool, uiTestLaunch: Bool, fixtureAsks: Bool) -> Bool {
        if fixtureAsks { return false }
        return testHost || uiTestLaunch
    }

    static let micText = "Tip: touch and hold the mic for the voice panel"
    static let headphonesText = "Tip: touch and hold the headphones for the voice panel"

    /// The button shows headphones while listen-only (a spectator who has not chosen to talk).
    static func text(listenOnly: Bool) -> String {
        listenOnly ? headphonesText : micText
    }
}

/// The tip's state, shared by every VoiceMuteButton (which reports itself on and off screen)
/// and the screens that draw the toast (VoicePanelTipToast: the table's top, under the lobby
/// header). Shown about a second after a mic button with voice on appears (a screen that is
/// only passing through never shows it), marked seen as it shows, gone after `visibleSeconds`
/// or a tap; a long press that opens the panel marks it seen too, before or while it shows.
@MainActor
final class VoicePanelTip: ObservableObject {
    static let seenKey = "voicePanelTipSeen"
    /// How long it stays up; `-uiVoiceTip YES` keeps it longer for screenshots and UI tests.
    static var visibleSeconds: TimeInterval = 6
    /// From a mic button on screen to the tip.
    static let showDelay: TimeInterval = 1

    static let shared: VoicePanelTip = {
        #if DEBUG
        // `-uiVoiceTipFresh YES`: a fresh install's flag (UI tests run in any order)
        if UIFixture.voiceTipFresh { UserDefaults.standard.removeObject(forKey: seenKey) }
        if UIFixture.showsVoiceTip { visibleSeconds = 60 }
        #endif
        return VoicePanelTip(defaults: .standard, suppressed: launchSuppressed)
    }()

    private static var launchSuppressed: Bool {
        let env = ProcessInfo.processInfo.environment
        let testHost = env["XCTestConfigurationFilePath"] != nil || env["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
        #if DEBUG
        return VoicePanelTipRule.suppressed(testHost: testHost,
                                            uiTestLaunch: UIFixture.isActive || ServerConfig.debugOverride != nil,
                                            fixtureAsks: UIFixture.showsVoiceTip)
        #else
        return VoicePanelTipRule.suppressed(testHost: testHost, uiTestLaunch: false, fixtureAsks: false)
        #endif
    }

    /// The toast's text while it shows.
    @Published private(set) var text: String?

    private let defaults: UserDefaults
    private let suppressed: Bool
    private let after: (TimeInterval, @escaping @MainActor () -> Void) -> Void
    private let announce: (String) -> Void
    /// The mic buttons on screen: voice on, listen-only.
    private var mics: [UUID: (voiceActive: Bool, listenOnly: Bool)] = [:]
    private var showPending = false
    private var shownCount = 0

    init(defaults: UserDefaults, suppressed: Bool,
         after: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, run in
             Task { @MainActor in
                 try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                 run()
             }
         },
         announce: @escaping (String) -> Void = { AccessibilityNotification.Announcement($0).post() }) {
        self.defaults = defaults
        self.suppressed = suppressed
        self.after = after
        self.announce = announce
    }

    var seen: Bool { defaults.bool(forKey: Self.seenKey) }

    private var due: Bool {
        VoicePanelTipRule.shouldShow(seen: seen, voiceActive: mics.values.contains { $0.voiceActive },
                                     micVisible: !mics.isEmpty, suppressed: suppressed)
    }

    /// A VoiceMuteButton came on screen or changed (`visible`), or left it.
    func mic(_ id: UUID, visible: Bool, voiceActive: Bool, listenOnly: Bool) {
        if visible {
            mics[id] = (voiceActive, listenOnly)
        } else {
            mics[id] = nil
        }
        guard text == nil, !showPending, due else { return }
        showPending = true
        after(Self.showDelay) { [weak self] in self?.showIfStillDue() }
    }

    private func showIfStillDue() {
        showPending = false
        guard text == nil, due else { return }
        defaults.set(true, forKey: Self.seenKey)
        let listenOnly = mics.values.first { $0.voiceActive }?.listenOnly ?? false
        let shown = VoicePanelTipRule.text(listenOnly: listenOnly)
        text = shown
        shownCount += 1
        let token = shownCount
        announce(shown)
        after(Self.visibleSeconds) { [weak self] in
            guard let self, self.shownCount == token else { return }
            self.dismiss()
        }
    }

    /// A long press opened the voice panel: nothing left to teach.
    func panelOpened() {
        defaults.set(true, forKey: Self.seenKey)
        dismiss()
    }

    /// A tap on the toast, or its time is up.
    func dismiss() {
        if text != nil { text = nil }
    }
}
