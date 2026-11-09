import SwiftUI

/// Root navigation switch — replaces screens like the web client.
struct ContentView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService
    @State private var showSplash = true

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
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
        .onAppear {
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
