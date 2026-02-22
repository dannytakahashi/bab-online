import SwiftUI

/// Root navigation switch — replaces screens like the web client.
struct ContentView: View {
    @EnvironmentObject var appState: AppState
    @State private var showSplash = true

    var body: some View {
        ZStack {
            if showSplash {
                SplashView()
                    .transition(.opacity)
            } else {
                Group {
                    switch appState.screen {
                    case .signIn:
                        SignInView()
                    case .register:
                        RegisterView()
                    case .mainRoom:
                        MainRoomView()
                    case .gameLobby:
                        GameLobbyView()
                    case .game:
                        GameContainerView()
                    }
                }
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
        .onAppear {
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
