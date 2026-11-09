import SwiftUI

/// Root navigation switch — replaces screens like the web client.
struct ContentView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService
    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var lobbyState: LobbyState
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var gameState: GameState
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @Environment(\.verticalSizeClass) private var vSizeClass
    @State private var showSplash = true

    /// Card faces render off the main thread from the game / tournament lobby on (or a
    /// rejoin straight into the game), so the first deal finds them cached (once per process).
    static func prewarmCards(for screen: AppState.Screen) {
        switch screen {
        case .gameLobby, .tournamentLobby, .game: CardTextureGenerator.prewarm()
        case .signIn, .register, .mainRoom: break
        }
    }

    var body: some View {
        ZStack {
            if showSplash {
                SplashView()
                    .transition(.opacity)
            } else {
                ZStack {
                    Group {
                        switch appState.screen {
                        case .signIn:
                            SignInView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.signIn")
                        case .register:
                            RegisterView()
                        case .mainRoom:
                            MainRoomView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.mainRoom")
                        case .gameLobby:
                            GameLobbyView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.gameLobby")
                        case .tournamentLobby:
                            TournamentLobbyView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.tournamentLobby")
                        case .game:
                            GameContainerView()
                        }
                    }

                    if authState.isAuthenticated {
                        ConnectionStatusToast()
                    }
                }
                .transition(.opacity)
            }
        }
        #if DEBUG
        .overlay {
            if UIFixture.isActive {
                FixtureWindowProbe().ignoresSafeArea(.keyboard)
                FixtureProbes()
            }
        }
        #endif
        .preferredColorScheme(.dark)
        // the orientation mask follows the window scene's size classes (Duo fold / unfold)
        .onChange(of: hSizeClass) { OrientationLock.refresh() }
        .onChange(of: vSizeClass) { OrientationLock.refresh() }
        // drafts survive a rotation, not their context (sign-out, leaving a lobby or a game)
        .onChange(of: appState.screen) { old, new in
            ChatDrafts.screenChanged(from: old, to: new, mainRoom: mainRoomState, lobby: lobbyState,
                                     tournament: tournamentState, game: gameState)
            Self.prewarmCards(for: new)
        }
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
        .onAppear {
            Self.prewarmCards(for: appState.screen)
            #if DEBUG
            if UIFixture.isActive { showSplash = false; return }
            #endif
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                withAnimation(.easeInOut(duration: 0.4)) {
                    showSplash = false
                }
            }
        }
    }
}

// Make Screen equatable for animation
extension AppState.Screen: Equatable {}
