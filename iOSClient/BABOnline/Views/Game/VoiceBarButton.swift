import SwiftUI

/// Where the game screen draws my own mic (GameContainerView.micSpot; pure, for the tests).
enum MicSpot: Equatable {
    case none
    /// My seat's row (a seat holder, a lazy owner watching their seat).
    case seatRow
    /// Beside the spectator pill (a pure spectator not watching a hand).
    case pill
    /// Directly above the eye (a watcher, TableLayout.watcherCluster).
    case eye
    /// The vertical bar (VoiceBarButton): any of the above while the bar shows the table's
    /// controls (the iPhone Duo closed, open in landscape, book pose).
    case bar

    /// - barControls: the vertical bar is in use and shows the table's items (in the game).
    /// - seatVoice: a seat's mic is up (voice running, not a pure spectator).
    /// - spectatorVoice: a pure spectator's mic is up (a casual game's spectator voice).
    static func of(barControls: Bool, seatVoice: Bool, pureSpectator: Bool, spectatorVoice: Bool, watching: Bool) -> MicSpot {
        if seatVoice && !pureSpectator {
            if barControls { return .bar }
            return watching ? .none : .seatRow
        }
        if pureSpectator && spectatorVoice {
            if barControls { return .bar }
            return watching ? .eye : .pill
        }
        return .none
    }
}

/// The voice mic as a vertical bar item (the iPhone Duo's side column with the status bar:
/// closed, open in landscape, book pose; iOS 27.1), in place of the felt's VoiceMuteButton
/// (my seat's row, a spectator's pill, a watcher's spot above the eye; owner 2026-11-22).
///
/// A bar item gets no SwiftUI long press (the bar builds its own button), so it is a
/// `Menu` with a primary action: a tap mutes / unmutes (the first unmute asks for the mic,
/// as on the felt), touching and holding opens a one-item menu whose "Voice panel…" opens
/// the panel. The glyph shows the state, as the felt's circle does: the mic, the slashed mic
/// in the danger red while muted, the headphones once the mic was refused, and the mic in
/// the success green while I am talking (the felt's speaking ring).
struct VoiceBarButton: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    let onPanel: () -> Void
    /// UI fixtures: draw the refused-mic (listen-only) state without a voice session.
    var forceListenOnly = false

    /// This button on screen for the voice panel tip (VoicePanelTip).
    @State private var tipID = UUID()

    private var listenOnly: Bool { forceListenOnly || voiceManager.isListenOnly }
    private var muted: Bool { !listenOnly && voiceManager.isSelfMuted }
    private var speaking: Bool { !listenOnly && voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted }

    static let panelItem = "Voice panel\u{2026}"

    var body: some View {
        Menu {
            Button(action: openPanel) {
                Label(Self.panelItem, systemImage: "slider.horizontal.3")
            }
        } label: {
            Label(label, systemImage: symbol)
        } primaryAction: {
            tapped()
        }
        .tint(tint)
        .accessibilityLabel(label)
        .accessibilityHint(listenOnly ? "\(VoiceCopy.noMicHint) \(VoiceCopy.panelHint)" : VoiceCopy.panelHint)
        .accessibilityAction(named: "Voice panel") { openPanel() }
        .accessibilityIdentifier("voice.bar")
        .onAppear { reportToTip(visible: true) }
        .onChange(of: [voiceOn, listenOnly]) { _, _ in reportToTip(visible: true) }
        .onDisappear { reportToTip(visible: false) }
    }

    /// The glyph, as the felt button's (VoiceMuteButton).
    var symbol: String { Self.symbol(listenOnly: listenOnly, muted: voiceManager.isSelfMuted) }
    /// Muted red, talking green, else the bar's own colour.
    var tint: Color? { Self.tint(listenOnly: listenOnly, muted: voiceManager.isSelfMuted, speaking: voiceManager.isSelfSpeaking) }

    static func symbol(listenOnly: Bool, muted: Bool) -> String {
        listenOnly ? "headphones" : muted ? "mic.slash.fill" : "mic.fill"
    }

    static func tint(listenOnly: Bool, muted: Bool, speaking: Bool) -> Color? {
        if listenOnly { return nil }
        if muted { return Theme.danger }
        return speaking ? Theme.success : nil
    }

    private var label: String {
        if listenOnly { return VoiceCopy.noMic }
        return voiceManager.isSelfMuted ? "Unmute microphone" : "Mute microphone"
    }

    private var voiceOn: Bool {
        #if DEBUG
        return voiceManager.isActive || forceListenOnly || UIFixture.showsVoiceButton || UIFixture.showsSpectatorVoiceButton
        #else
        return voiceManager.isActive || forceListenOnly
        #endif
    }

    private func reportToTip(visible: Bool) {
        VoicePanelTip.shared.mic(tipID, visible: visible, voiceActive: voiceOn, listenOnly: listenOnly)
    }

    private func openPanel() {
        HapticManager.mediumImpact()
        VoicePanelTip.shared.panelOpened()
        onPanel()
    }

    private func tapped() {
        HapticManager.lightImpact()
        guard !forceListenOnly else { return }
        voiceManager.toggleSelfMute()
    }
}
