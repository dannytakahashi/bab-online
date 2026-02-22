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
                if gameState.isBidding && gameState.isMyTurn {
                    BidOverlayView()
                        .padding(.bottom, 200)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
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
        }
    }
}
