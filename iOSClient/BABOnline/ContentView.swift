import SwiftUI

/// Root navigation switch — replaces screens like the web client.
struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
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
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
    }
}

// Make Screen equatable for animation
extension AppState.Screen: Equatable {}
