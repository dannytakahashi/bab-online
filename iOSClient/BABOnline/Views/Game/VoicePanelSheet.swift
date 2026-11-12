import SwiftUI

/// Bottom sheet showing voice chat participants with mute controls.
struct VoicePanelSheet: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                // Self row
                HStack(spacing: Theme.Space.s3) {
                    speakingDot(isSpeaking: voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted)

                    Text("You")
                        .foregroundColor(Theme.textPrimary)
                        .fontWeight(.medium)

                    Spacer()

                    Button(action: {
                        voiceManager.toggleSelfMute()
                        HapticManager.lightImpact()
                    }) {
                        Image(systemName: voiceManager.isSelfMuted ? "mic.slash.fill" : "mic.fill")
                            .foregroundColor(voiceManager.isSelfMuted ? Theme.error : Theme.textSecondary)
                            .frame(width: Theme.hitTarget, height: Theme.hitTarget)
                    }
                    .accessibilityLabel(voiceManager.isSelfMuted ? "Unmute microphone" : "Mute microphone")
                }
                .listRowBackground(Theme.surface)

                // Peer rows
                ForEach(Array(voiceManager.peerInfos.keys.sorted()), id: \.self) { socketId in
                    if let info = voiceManager.peerInfos[socketId] {
                        HStack(spacing: Theme.Space.s3) {
                            speakingDot(isSpeaking: voiceManager.speakingPeers.contains(socketId))

                            Text(info.username)
                                .foregroundColor(Theme.textPrimary)

                            if info.isUnavailable {
                                // the connection failed after its one restart (VoiceRecovery)
                                Text("voice unavailable")
                                    .font(.caption)
                                    .foregroundColor(Theme.textSecondary)
                            }

                            Spacer()

                            Button(action: {
                                voiceManager.togglePeerMute(socketId)
                                HapticManager.lightImpact()
                            }) {
                                Image(systemName: info.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                    .foregroundColor(info.isMuted ? Theme.error : Theme.textSecondary)
                                    .frame(width: Theme.hitTarget, height: Theme.hitTarget)
                            }
                            .accessibilityLabel(info.isMuted ? "Unmute \(info.username)" : "Mute \(info.username)")
                        }
                        .listRowBackground(Theme.surface)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Voice Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func speakingDot(isSpeaking: Bool) -> some View {
        Circle()
            .fill(isSpeaking ? Theme.success : Theme.surfaceRaised)
            .frame(width: 10, height: 10)
            .animation(.easeInOut(duration: Theme.Motion.base), value: isSpeaking)
    }
}
