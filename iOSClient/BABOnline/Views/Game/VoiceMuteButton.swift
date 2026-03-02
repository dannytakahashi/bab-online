import SwiftUI

/// Floating circular mic mute/unmute button for voice chat.
struct VoiceMuteButton: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    let onLongPress: () -> Void

    var body: some View {
        Button(action: {
            voiceManager.toggleSelfMute()
            HapticManager.lightImpact()
        }) {
            Image(systemName: voiceManager.isSelfMuted ? "mic.slash.fill" : "mic.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: 44, height: 44)
                .background(voiceManager.isSelfMuted ? Color.red.opacity(0.9) : Color(white: 0.2).opacity(0.9))
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .stroke(voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted
                                ? Color.green : Color(white: 0.4),
                                lineWidth: voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted ? 2 : 1)
                )
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in
                    HapticManager.mediumImpact()
                    onLongPress()
                }
        )
    }
}
