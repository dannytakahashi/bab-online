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
    /// The one "the server restarted" message after a reconnect (RestartNotice).
    @ObservedObject private var restart = RestartNotices.shared

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
                // over the next screen, which is drawn under it as it fades (no dip to black)
                SplashView(onFinished: {
                    withAnimation(.easeInOut(duration: SplashTimeline.handOff)) { showSplash = false }
                })
                .zIndex(1)
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
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.register")
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

                    if authState.isAuthenticated || authState.restoreRetrying {
                        ConnectionStatusToast()
                    }
                }
                .zIndex(0)
                .transition(.identity)
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
        // the one-time passwordReset notice after a sign-in or restore (AccountRules.swift)
        .alert("Password reset", isPresented: Binding(get: { authState.accountNotice != nil && !showSplash },
                                                       set: { if !$0 { authState.accountNotice = nil } })) {
            Button("OK", role: .cancel) { authState.accountNotice = nil }
        } message: {
            Text(authState.accountNotice ?? "")
        }
        // a standard alert: VoiceOver moves to it and reads it
        .alert("Server restarted", isPresented: Binding(get: { restart.message != nil && !showSplash },
                                                         set: { if !$0 { restart.message = nil } })) {
            Button("OK", role: .cancel) { restart.message = nil }
        } message: {
            Text(restart.message ?? "")
        }
        .preferredColorScheme(.dark)
        // the orientation mask follows the window scene's size classes (Duo fold / unfold)
        .onChange(of: hSizeClass) { OrientationLock.refresh() }
        .onChange(of: vSizeClass) { OrientationLock.refresh() }
        // drafts survive a rotation, not their context (sign-out, leaving a lobby or a game)
        .onChange(of: appState.screen) { old, new in
            ChatDrafts.screenChanged(from: old, to: new, mainRoom: mainRoomState, lobby: lobbyState,
                                     tournament: tournamentState, game: gameState)
            Self.prewarmCards(for: new)
            // the admin panel closes off the main room and when the flag drops (as the web's);
            // not observed here: the panel's every change would redraw the whole app
            if new != .mainRoom { AdminState.shared.close() }
        }
        .onChange(of: authState.isAdmin) { _, isAdmin in
            if !isAdmin { AdminState.shared.close() }
        }
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
        .onAppear {
            Self.prewarmCards(for: appState.screen)
            // the splash ends itself (SplashView's onFinished, 1.25 s; 0.9 s under Reduce Motion)
            #if DEBUG
            if UIFixture.isActive && !UIFixture.showsSplash { showSplash = false }
            #endif
        }
    }
}

// Make Screen equatable for animation
extension AppState.Screen: Equatable {}
