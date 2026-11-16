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
                        VStack(alignment: .leading, spacing: 0) {
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
                        volumeRow(socketId, info)
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

    /// This player's volume for me only, 0 to 200% (the web's per-peer slider): the remote
    /// track's source gain (`VoiceChatManager.setPeerVolume`), kept while the app runs.
    private func volumeRow(_ socketId: String, _ info: VoiceChatManager.PeerInfo) -> some View {
        HStack(spacing: Theme.Space.s2) {
            Image(systemName: "speaker.fill")
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .accessibilityHidden(true)
            Slider(value: Binding(get: { voiceManager.peerInfos[socketId]?.volume ?? VoiceVolume.normal },
                                  set: { voiceManager.setPeerVolume(socketId, $0) }),
                   in: VoiceVolume.range, step: VoiceVolume.step)
                .tint(Theme.teamA)
                .accessibilityLabel("\(info.username) volume")
                .accessibilityValue(VoiceVolume.percentText(info.volume))
                .accessibilityIdentifier("voice.volume.\(info.username)")
            Text(VoiceVolume.percentText(info.volume))
                .font(.caption.monospacedDigit())
                .foregroundColor(Theme.textSecondary)
                .frame(minWidth: 44, alignment: .trailing)
                .accessibilityHidden(true)
        }
        .padding(.leading, 10 + Theme.Space.s3)  // under the name, past the speaking dot
        .padding(.bottom, Theme.Space.s1)
    }

    private func speakingDot(isSpeaking: Bool) -> some View {
        Circle()
            .fill(isSpeaking ? Theme.success : Theme.surfaceRaised)
            .frame(width: 10, height: 10)
            .animation(.easeInOut(duration: Theme.Motion.base), value: isSpeaking)
    }
}
