import SwiftUI

/// Floating circular mic mute/unmute button for voice chat. Voice starts muted (build 16,
/// owner 2026-11-18; a later start in the same app run unmuted after an unmute by hand, owner
/// 2026-11-19): the first tap unmutes and asks for the microphone then. Once the mic was
/// refused it shows headphones ("Listening only (no mic access)"); a tap asks again. It is
/// never `.disabled`, which would also end the long press that
/// opens the voice panel. That long press is the panel only: the Button's action that
/// SwiftUI still fires when the finger lifts is skipped (`longPressFired`), so it never also
/// mutes, unmutes or asks for the mic (owner 2026-11-18: a spectator's hold on the
/// headphones turned the mic on).
struct VoiceMuteButton: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    let onLongPress: () -> Void
    /// The circle's diameter: the 44 pt target, times the table's zoom in my seat's row
    /// (TableLayout.voiceButtonSize scene units; the glyph stays Dynamic Type).
    var size: CGFloat = Theme.hitTarget
    /// UI fixtures: draw the refused-mic (listen-only) state without a voice session.
    var forceListenOnly = false

    private var listenOnly: Bool { forceListenOnly || voiceManager.isListenOnly }

    /// This button on screen for the voice panel tip (VoicePanelTip).
    @State private var tipID = UUID()
    /// Set when this press became the panel's long press; cleared at every touch-down, so a
    /// hold that slid off the button (no action) never swallows the next tap.
    @State private var longPressFired = false
    /// Voice on, for the tip: a fixture's button (`-uiVoice YES`, `-uiSpectatorVoice muted|denied`) counts.
    private var voiceOn: Bool {
        #if DEBUG
        return voiceManager.isActive || forceListenOnly || UIFixture.showsVoiceButton || UIFixture.showsSpectatorVoiceButton
        #else
        return voiceManager.isActive || forceListenOnly
        #endif
    }

    var body: some View {
        Button(action: tapped) {
            Image(systemName: listenOnly ? "headphones" : voiceManager.isSelfMuted ? "mic.slash.fill" : "mic.fill")
                .font(.body.weight(.semibold))
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)  // the glyph stays inside the 44 pt circle
                .foregroundColor(Theme.textPrimary)
                .frame(width: size, height: size)
                .background(!listenOnly && voiceManager.isSelfMuted ? Theme.danger : Theme.Palette.Surface.s2.opacity(0.9).color)
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(speaking ? Theme.success : Theme.inputBorder, lineWidth: speaking ? 2 : 1)
                )
        }
        .accessibilityLabel(label)
        // listen-only: the tap still tries the mic (VoiceOver says so; the web's button reads
        // "Tap to talk (no mic access yet)")
        .accessibilityHint(listenOnly ? "\(VoiceCopy.noMicHint) \(VoiceCopy.panelHint)" : VoiceCopy.panelHint)
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onChanged { _ in longPressFired = false }
                .onEnded { _ in
                    longPressFired = true
                    HapticManager.mediumImpact()
                    VoicePanelTip.shared.panelOpened()
                    onLongPress()
                }
        )
        .onAppear { reportToTip(visible: true) }
        .onChange(of: [voiceOn, listenOnly]) { _, _ in reportToTip(visible: true) }
        .onDisappear { reportToTip(visible: false) }
    }

    private func reportToTip(visible: Bool) {
        VoicePanelTip.shared.mic(tipID, visible: visible, voiceActive: voiceOn, listenOnly: listenOnly)
    }

    private var speaking: Bool { !listenOnly && voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted }

    private var label: String {
        if listenOnly { return VoiceCopy.noMic }
        return voiceManager.isSelfMuted ? "Unmute microphone" : "Mute microphone"
    }

    private func tapped() {
        if longPressFired {
            longPressFired = false
            return
        }
        HapticManager.lightImpact()
        guard !forceListenOnly else { return }
        // muted: unmute (the first one asks for the mic; after a refusal it asks again)
        voiceManager.toggleSelfMute()
    }
}
