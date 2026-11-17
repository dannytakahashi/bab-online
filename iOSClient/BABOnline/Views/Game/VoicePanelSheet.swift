import SwiftUI

/// Bottom sheet showing voice chat participants with mute controls.
struct VoicePanelSheet: View {
    @ObservedObject var voiceManager = VoiceChatManager.shared
    @Environment(\.dismiss) private var dismiss
    /// The table's spectators (the spectator badge's names): their rows go under "Watching"
    /// with "(watching)" (1.2.2 (12), spectator voice). Empty in a lobby.
    var watching: Set<String> = []
    /// UI fixtures: show the listen-only self row without a voice session.
    var forceListenOnly = false

    private var listenOnly: Bool { forceListenOnly || voiceManager.isListenOnly }

    private var peerIds: [String] { voiceManager.peerInfos.keys.sorted() }
    private func isWatcher(_ id: String) -> Bool { voiceManager.peerInfos[id].map { watching.contains($0.username) } ?? false }

    var body: some View {
        NavigationView {
            List {
                // Self row
                HStack(spacing: Theme.Space.s3) {
                    speakingDot(isSpeaking: !listenOnly && voiceManager.isSelfSpeaking && !voiceManager.isSelfMuted)

                    Text("You")
                        .foregroundColor(Theme.textPrimary)
                        .fontWeight(.medium)

                    if listenOnly {
                        Text(VoiceCopy.listenOnlyLabel(talkAllowed: voiceManager.talkAllowed, micDenied: voiceManager.micPermissionDenied)
                                .lowercased())
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                            .accessibilityIdentifier("voice.panel.listenOnly")
                    }

                    Spacer()

                    if listenOnly {
                        Button(action: {
                            HapticManager.lightImpact()
                            guard !forceListenOnly else { return }
                            if let why = voiceManager.tapToTalk() {
                                SocketService.shared.serverError = ServerErrorNotice(message: why, kind: .info)
                            }
                        }) {
                            Image(systemName: "headphones")
                                .foregroundColor(Theme.textSecondary)
                                .frame(width: Theme.hitTarget, height: Theme.hitTarget)
                        }
                        .accessibilityLabel(VoiceCopy.listenOnlyLabel(talkAllowed: voiceManager.talkAllowed,
                                                                      micDenied: voiceManager.micPermissionDenied))
                    } else {
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
                }
                .listRowBackground(Theme.surface)

                if listenOnly {
                    Text(VoiceCopy.micDotNote)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .listRowBackground(Theme.surface)
                }

                // The in-game "Spectators can talk" (voiceSettings.canChange: the host while
                // seated, else a capable player); the toggle waits for the server's answer
                if let settings = voiceManager.settings, settings.canChange {
                    Toggle(isOn: Binding(get: { voiceManager.switchPending ?? settings.spectatorsCanTalk },
                                         set: { value in
                                             voiceManager.switchPending = value
                                             LobbyEmitter.setSpectatorsCanTalk(value)
                                             let asked = value
                                             DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                                                 if voiceManager.switchPending == asked { voiceManager.switchPending = nil }
                                             }
                                         })) {
                        Text(VoiceCopy.switchLabel)
                            .foregroundColor(Theme.textPrimary)
                    }
                    .tint(Theme.success)
                    .disabled(voiceManager.switchPending != nil)
                    .accessibilityIdentifier("voice.spectatorsCanTalk")
                    .listRowBackground(Theme.surface)
                }

                // Peer rows: the players, then "Watching"
                ForEach(peerIds.filter { !isWatcher($0) }, id: \.self) { socketId in
                    peerRow(socketId)
                }
                let watchers = peerIds.filter { isWatcher($0) }
                if !watchers.isEmpty {
                    Section(header: Text("Watching").foregroundColor(Theme.textSecondary)) {
                        ForEach(watchers, id: \.self) { socketId in
                            peerRow(socketId, watcher: true)
                        }
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

    @ViewBuilder
    private func peerRow(_ socketId: String, watcher: Bool = false) -> some View {
                    if let info = voiceManager.peerInfos[socketId] {
                        VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: Theme.Space.s3) {
                            speakingDot(isSpeaking: voiceManager.speakingPeers.contains(socketId))

                            Text(info.username)
                                .foregroundColor(Theme.textPrimary)

                            if watcher {
                                Text("(watching)")
                                    .font(.caption)
                                    .foregroundColor(Theme.textSecondary)
                            }

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
                .disabled(info.isUnavailable)  // no audio to adjust until the peer's next offer
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
