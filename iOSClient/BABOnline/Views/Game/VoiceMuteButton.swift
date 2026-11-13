import SwiftUI

/// Floating circular mic mute/unmute button for voice chat.
struct VoiceMuteButton: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    let onLongPress: () -> Void
    /// The circle's diameter: the 44 pt target, times the table's zoom in my seat's row
    /// (TableLayout.voiceButtonSize scene units; the glyph stays Dynamic Type).
    var size: CGFloat = Theme.hitTarget

    var body: some View {
        Button(action: {
            voiceManager.toggleSelfMute()
            HapticManager.lightImpact()
        }) {
            Image(systemName: voiceManager.isSelfMuted ? "mic.slash.fill" : "mic.fill")
                .font(.body.weight(.semibold))
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)  // the glyph stays inside the 44 pt circle
                .foregroundColor(Theme.textPrimary)
                .frame(width: size, height: size)
                .background(voiceManager.isSelfMuted ? Theme.danger : Theme.Palette.Surface.s2.opacity(0.9).color)
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted
                                ? Theme.success : Theme.inputBorder,
                                lineWidth: voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted ? 2 : 1)
                )
        }
        .accessibilityLabel(voiceManager.isSelfMuted ? "Unmute microphone" : "Mute microphone")
        .accessibilityHint("Touch and hold for the voice panel")
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in
                    HapticManager.mediumImpact()
                    onLongPress()
                }
        )
    }
}
