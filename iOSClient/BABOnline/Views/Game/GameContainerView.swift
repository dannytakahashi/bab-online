import SwiftUI
import SpriteKit

/// Hosts the SpriteKit game scene with SwiftUI overlay panels.
struct GameContainerView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var appState: AppState

    @State private var scene: GameSKScene = {
        let s = GameSKScene()
        s.scaleMode = .resizeFill
        return s
    }()

    @State private var showGameLog = false
    @State private var showVoicePanel = false
    @ObservedObject private var voiceManager = VoiceChatManager.shared

    var body: some View {
        ZStack {
            // SpriteKit scene
            SpriteView(scene: scene)
                .ignoresSafeArea()

            // SwiftUI overlays
            VStack(spacing: 0) {
                // Score bar pinned to top of safe area
                if gameState.phase == .bidding || gameState.phase == .playing {
                    ScoreBarView()
                }

                Spacer()

                // Bid overlay above cards
                if gameState.isBidding && gameState.isMyTurn && !gameState.isReadOnly {
                    BidOverlayView()
                        .padding(.bottom, 200)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }

            // HSI display and voice mute button (bottom-right, above card hand)
            // Placed before game log in ZStack so it renders underneath
            // Hide when bid overlay is visible to avoid overlap
            if (gameState.phase == .bidding || gameState.phase == .playing)
                && !(gameState.isBidding && gameState.isMyTurn && !gameState.isReadOnly) {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        VStack(alignment: .trailing, spacing: 8) {
                            // HSI display
                            if !gameState.isSpectator,
                               let myPos = gameState.position,
                               let hsi = gameState.hsiValues[myPos] {
                                Text("HSI: \(String(format: "%.1f", hsi))")
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundColor(Color(white: 0.67))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(Color.black.opacity(0.7))
                                    .cornerRadius(4)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 4)
                                            .stroke(Color(white: 0.4), lineWidth: 1)
                                    )
                            }

                            // Voice mute button
                            if voiceManager.isActive {
                                VoiceMuteButton(onLongPress: {
                                    showVoicePanel = true
                                })
                            }
                        }
                        .padding(.trailing, 12)
                        .padding(.bottom, 190)
                    }
                }
            }

            // Game log toggle button
            if gameState.phase == .bidding || gameState.phase == .playing {
                VStack {
                    HStack {
                        Spacer()
                        Button(action: {
                            withAnimation {
                                showGameLog.toggle()
                                if showGameLog {
                                    gameState.unreadChatCount = 0
                                }
                            }
                        }) {
                            Image(systemName: showGameLog ? "xmark.circle.fill" : "text.bubble.fill")
                                .font(.title2)
                                .foregroundColor(Color.Theme.textSecondary)
                                .padding(12)
                                .background(Color.Theme.surface.opacity(0.8))
                                .clipShape(Circle())
                                .overlay(alignment: .topTrailing) {
                                    if !showGameLog && gameState.unreadChatCount > 0 {
                                        Text("\(gameState.unreadChatCount)")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundStyle(.white)
                                            .frame(minWidth: 18, minHeight: 18)
                                            .background(Color.Theme.error)
                                            .clipShape(Circle())
                                            .offset(x: 4, y: -4)
                                    }
                                }
                        }
                        .padding(.trailing, 12)
                        .padding(.top, 80)
                    }
                    Spacer()
                }
            }

            // Game log panel
            if showGameLog {
                GameLogView(isShowing: $showGameLog)
                    .transition(.move(edge: .trailing))
            }

            // Disconnect banner
            if !gameState.disconnectedPlayers.isEmpty {
                VStack {
                    DisconnectBannerView()
                        .padding(.top, gameState.phase == .bidding || gameState.phase == .playing ? 50 : 0)
                    Spacer()
                }
            }

            // Spectator / Lazy mode indicator
            if gameState.isSpectator && !gameState.isLazy {
                VStack {
                    Spacer()
                    Text("Spectating \u{2014} type /leave to exit")
                        .font(.caption.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color(red: 0.376, green: 0.647, blue: 0.98).opacity(0.9))
                        .cornerRadius(8)
                        .padding(.bottom, 12)
                }
            } else if gameState.isLazy {
                VStack {
                    Spacer()
                    Text("Spectating \u{2014} type /active to take back control")
                        .font(.caption.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.green.opacity(0.8))
                        .cornerRadius(8)
                        .padding(.bottom, 12)
                }
            }

            // Draw phase overlay
            if gameState.phase == .draw {
                DrawPhaseView()
                    .transition(.opacity)
            }

            // Game end modal
            if gameState.phase == .ended, gameState.gameEndData != nil {
                GameEndView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: gameState.isBidding)
        .animation(.easeInOut(duration: 0.3), value: gameState.phase)
        .onAppear {
            scene.configure(gameState: gameState)
        }
        .onDisappear {
            scene.cleanupAll()
            VoiceChatManager.shared.shutdown()
        }
        .sheet(isPresented: $showVoicePanel) {
            VoicePanelSheet()
                .presentationDetents([.medium])
        }
    }
}
