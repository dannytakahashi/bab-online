import SwiftUI

/// Floating circular mic mute/unmute button for voice chat.
/// Listen-only (1.2.3: a spectator who may not or has not chosen to talk, or a refused mic)
/// it shows headphones: a tap is "Tap to talk" (asks for the mic) when talking is allowed,
/// else a toast says why. It is never `.disabled`, which would also end the long press that
/// opens the voice panel.
struct VoiceMuteButton: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    let onLongPress: () -> Void
    /// The circle's diameter: the 44 pt target, times the table's zoom in my seat's row
    /// (TableLayout.voiceButtonSize scene units; the glyph stays Dynamic Type).
    var size: CGFloat = Theme.hitTarget
    /// UI fixtures: draw the listen-only state without a voice session.
    var forceListenOnly = false

    private var listenOnly: Bool { forceListenOnly || voiceManager.isListenOnly }

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
        .accessibilityHint("Touch and hold for the voice panel")
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in
                    HapticManager.mediumImpact()
                    onLongPress()
                }
        )
    }

    private var speaking: Bool { !listenOnly && voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted }

    private var label: String {
        if listenOnly {
            return VoiceCopy.listenOnlyLabel(talkAllowed: voiceManager.talkAllowed, micDenied: voiceManager.micPermissionDenied)
        }
        return voiceManager.isSelfMuted ? "Unmute microphone" : "Mute microphone"
    }

    private func tapped() {
        HapticManager.lightImpact()
        guard listenOnly else {
            voiceManager.toggleSelfMute()
            return
        }
        guard !forceListenOnly else { return }
        if let why = voiceManager.tapToTalk() {
            SocketService.shared.serverError = ServerErrorNotice(message: why, kind: .info)
        }
    }
}
