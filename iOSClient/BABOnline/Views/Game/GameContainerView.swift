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
                // Score bar at top
                if gameState.phase == .bidding || gameState.phase == .playing {
                    ScoreBarView()
                        .padding(.top, safeAreaTop)
                }

                Spacer()

                // Bid overlay at bottom
                if gameState.isBidding && gameState.isMyTurn {
                    BidOverlayView()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }

            // Game log toggle button
            if gameState.phase == .bidding || gameState.phase == .playing {
                VStack {
                    HStack {
                        Spacer()
                        Button(action: { withAnimation { showGameLog.toggle() } }) {
                            Image(systemName: showGameLog ? "xmark.circle.fill" : "text.bubble.fill")
                                .font(.title2)
                                .foregroundColor(Color.Theme.textSecondary)
                                .padding(12)
                                .background(Color.Theme.surface.opacity(0.8))
                                .clipShape(Circle())
                        }
                        .padding(.trailing, 12)
                        .padding(.top, safeAreaTop + 50)
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
                        .padding(.top, safeAreaTop + (gameState.phase == .bidding || gameState.phase == .playing ? 50 : 0))
                    Spacer()
                }
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

    private var safeAreaTop: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows.first?.safeAreaInsets.top ?? 0
    }
}
