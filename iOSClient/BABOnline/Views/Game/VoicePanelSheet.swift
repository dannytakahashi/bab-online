import SwiftUI

/// Bottom sheet showing voice chat participants with mute controls.
struct VoicePanelSheet: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared

    var body: some View {
        NavigationView {
            List {
                // Self row
                HStack(spacing: 12) {
                    speakingDot(isSpeaking: voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted)

                    Text("You")
                        .foregroundColor(Color.Theme.textPrimary)
                        .fontWeight(.medium)

                    Spacer()

                    Button(action: {
                        voiceManager.toggleSelfMute()
                        HapticManager.lightImpact()
                    }) {
                        Image(systemName: voiceManager.isSelfMuted ? "mic.slash.fill" : "mic.fill")
                            .foregroundColor(voiceManager.isSelfMuted ? .red : Color.Theme.textSecondary)
                            .frame(width: 32, height: 32)
                    }
                }
                .listRowBackground(Color.Theme.surface)

                // Peer rows
                ForEach(Array(voiceManager.peerInfos.keys.sorted()), id: \.self) { socketId in
                    if let info = voiceManager.peerInfos[socketId] {
                        HStack(spacing: 12) {
                            speakingDot(isSpeaking: voiceManager.speakingPeers.contains(socketId))

                            Text(info.username)
                                .foregroundColor(Color.Theme.textPrimary)

                            Spacer()

                            Button(action: {
                                voiceManager.togglePeerMute(socketId)
                                HapticManager.lightImpact()
                            }) {
                                Image(systemName: info.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                    .foregroundColor(info.isMuted ? .red : Color.Theme.textSecondary)
                                    .frame(width: 32, height: 32)
                            }
                        }
                        .listRowBackground(Color.Theme.surface)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.Theme.background)
            .navigationTitle("Voice Chat")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func speakingDot(isSpeaking: Bool) -> some View {
        Circle()
            .fill(isSpeaking ? Color.green : Color(white: 0.3))
            .frame(width: 10, height: 10)
            .animation(.easeInOut(duration: 0.2), value: isSpeaking)
    }
}
